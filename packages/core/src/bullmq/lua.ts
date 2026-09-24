/**
 * swarmy's own READ-ONLY Lua for the queue studio. Each script returns ONE
 * `cjson.encode(...)` string, so the controller parses a single JSON document
 * whatever the shape (valkey-cli's reply flattening never gets a say).
 *
 * Every read is bounded: discovery SCANs a capped number of iterations, job
 * pages are capped, payloads are cut to a byte budget, and key reads go
 * through `redis.pcall` so a key of an unexpected type counts as empty rather
 * than failing the whole probe.
 *
 * Key layout (BullMQ v5, prefix `bull` by default — `<p>:<q>:<suffix>`):
 *   wait, paused, active                     lists (LPUSH, workers pop the tail)
 *   prioritized, delayed, completed, failed,
 *   waiting-children                         zsets
 *   meta                                     hash (`paused` field = paused)
 *   events                                   stream (`event` is the first field)
 *   id                                       job-id counter (jobs ever added)
 *   metrics:completed / metrics:failed       hash with a monotonic `count`
 *                                            (only when the worker enables metrics)
 *   <jobId>                                  job hash; <jobId>:logs list
 * A `0:<ts>` tail entry on wait/paused is a legacy v4 marker, not a job.
 */

/** Shared helpers prepended to every read script. */
const PRELUDE = `
local function num(cmd, key)
  local r = redis.pcall(cmd, key)
  if type(r) == 'number' then return r end
  return 0
end
local function listCount(key)
  local n = num('LLEN', key)
  if n > 0 then
    local last = redis.pcall('LINDEX', key, -1)
    if type(last) == 'string' and string.sub(last, 1, 2) == '0:' then n = n - 1 end
  end
  return n
end
local function counts(base)
  return {
    wait = listCount(base .. 'wait'),
    paused = listCount(base .. 'paused'),
    active = num('LLEN', base .. 'active'),
    prioritized = num('ZCARD', base .. 'prioritized'),
    delayed = num('ZCARD', base .. 'delayed'),
    completed = num('ZCARD', base .. 'completed'),
    failed = num('ZCARD', base .. 'failed'),
    waitingChildren = num('ZCARD', base .. 'waiting-children'),
  }
end
local function cut(s, max)
  if type(s) ~= 'string' then return nil, false end
  if #s > max then return string.sub(s, 1, max), true end
  return s, false
end
`;

/**
 * Discover + count. ARGV: [1] prefix, [2] max SCAN iterations, [3] JSON array
 * of queue names (empty ⇒ discover by `<prefix>:*:meta`), [4] JSON object
 * `{queue: lastEventStreamId}` — completed/failed events after that id are
 * counted (the rate sample), [5] max queues returned.
 */
export const OVERVIEW_LUA = `${PRELUDE}
local prefix = ARGV[1]
local maxIters = tonumber(ARGV[2])
local explicit = cjson.decode(ARGV[3])
local since = cjson.decode(ARGV[4])
local maxQueues = tonumber(ARGV[5])
local names = {}
local truncated = false
if #explicit > 0 then
  names = explicit
else
  local seen = {}
  local cursor = '0'
  local iters = 0
  local pat = prefix .. ':*:meta'
  repeat
    local r = redis.call('SCAN', cursor, 'MATCH', pat, 'COUNT', 1000)
    cursor = r[1]
    for _, k in ipairs(r[2]) do
      local q = string.sub(k, #prefix + 2, #k - 5)
      if q ~= '' and not string.find(q, ':', 1, true) and not seen[q] then
        seen[q] = true
        names[#names + 1] = q
      end
    end
    iters = iters + 1
  until cursor == '0' or iters >= maxIters
  if cursor ~= '0' then truncated = true end
end
table.sort(names)
if #names > maxQueues then
  truncated = true
  local keep = {}
  for i = 1, maxQueues do keep[i] = names[i] end
  names = keep
end
local out = {}
for _, q in ipairs(names) do
  local base = prefix .. ':' .. q .. ':'
  local ev = { completed = 0, failed = 0, lastId = cjson.null, saturated = false }
  local after = since[q]
  if type(after) == 'string' and after ~= '' then
    local rows = redis.pcall('XRANGE', base .. 'events', '(' .. after, '+', 'COUNT', 10000)
    if type(rows) == 'table' then
      for _, row in ipairs(rows) do
        local f = row[2]
        if f[1] == 'event' then
          if f[2] == 'completed' then ev.completed = ev.completed + 1
          elseif f[2] == 'failed' then ev.failed = ev.failed + 1 end
        end
        ev.lastId = row[1]
      end
      if #rows >= 10000 then ev.saturated = true end
      if ev.lastId == cjson.null then ev.lastId = after end
    end
  else
    local last = redis.pcall('XREVRANGE', base .. 'events', '+', '-', 'COUNT', 1)
    if type(last) == 'table' and last[1] then ev.lastId = last[1][1] end
  end
  local mc = redis.pcall('HGET', base .. 'metrics:completed', 'count')
  local mf = redis.pcall('HGET', base .. 'metrics:failed', 'count')
  local id = redis.pcall('GET', base .. 'id')
  out[#out + 1] = {
    name = q,
    counts = counts(base),
    isPaused = redis.pcall('HEXISTS', base .. 'meta', 'paused') == 1,
    jobsTotal = tonumber(type(id) == 'string' and id or '0') or 0,
    metricsCompleted = type(mc) == 'string' and tonumber(mc) or cjson.null,
    metricsFailed = type(mf) == 'string' and tonumber(mf) or cjson.null,
    events = ev,
  }
end
return cjson.encode({ queues = out, truncated = truncated })
`;

/** Job fields every summary/detail reads (HMGET order). */
const JOB_FIELDS = `local FIELDS = { 'name', 'data', 'opts', 'progress', 'atm', 'attemptsMade', 'ats',
  'timestamp', 'processedOn', 'finishedOn', 'failedReason', 'delay', 'priority', 'stacktrace',
  'returnvalue', 'processedBy', 'parentKey' }
local function jobRow(base, id, dataMax, withTrace)
  local v = redis.call('HMGET', base .. id, unpack(FIELDS))
  local row = { id = id }
  local present = false
  for i, f in ipairs(FIELDS) do
    if v[i] then present = true end
    row[f] = v[i] or cjson.null
  end
  if not present then return nil end
  local d, dt = cut(row.data ~= cjson.null and row.data or nil, dataMax)
  row.data = d or cjson.null
  row.dataTruncated = dt
  local r, rt = cut(row.returnvalue ~= cjson.null and row.returnvalue or nil, dataMax)
  row.returnvalue = r or cjson.null
  row.returnvalueTruncated = rt
  if not withTrace then
    row.stacktrace = nil
  else
    local s, st = cut(row.stacktrace ~= cjson.null and row.stacktrace or nil, dataMax)
    row.stacktrace = s or cjson.null
    row.stacktraceTruncated = st
  end
  return row
end
`;

/**
 * One page of a state. ARGV: [1] prefix, [2] queue, [3] state, [4] start,
 * [5] count, [6] payload byte budget. Lists and completed/failed read newest
 * first; delayed/prioritized/waiting-children read in score order (next up
 * first). A delayed job's run-at is its score >> 12 (BullMQ packs a counter
 * into the low 12 bits).
 */
export const JOBS_LUA = `${PRELUDE}${JOB_FIELDS}
local prefix, q, state = ARGV[1], ARGV[2], ARGV[3]
local start, count, dataMax = tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])
local base = prefix .. ':' .. q .. ':'
local key = base .. state
local isList = state == 'wait' or state == 'paused' or state == 'active'
local ids, scores, total = {}, {}, 0
if isList then
  total = (state == 'active') and num('LLEN', key) or listCount(key)
  local r = redis.pcall('LRANGE', key, start, start + count - 1)
  if type(r) == 'table' then
    for _, id in ipairs(r) do
      if string.sub(id, 1, 2) ~= '0:' then ids[#ids + 1] = id end
    end
  end
else
  total = num('ZCARD', key)
  local cmd = (state == 'completed' or state == 'failed') and 'ZREVRANGE' or 'ZRANGE'
  local r = redis.pcall(cmd, key, start, start + count - 1, 'WITHSCORES')
  if type(r) == 'table' then
    for i = 1, #r, 2 do
      ids[#ids + 1] = r[i]
      scores[r[i]] = tonumber(r[i + 1])
    end
  end
end
local jobs = {}
for _, id in ipairs(ids) do
  local row = jobRow(base, id, dataMax, false)
  if row then
    if state == 'delayed' and scores[id] then row.runAt = math.floor(scores[id] / 4096) end
    jobs[#jobs + 1] = row
  else
    jobs[#jobs + 1] = { id = id, missing = true }
  end
end
return cjson.encode({ state = state, total = total, start = start, jobs = jobs })
`;

/**
 * One job in full: fields, the state it is in, and its last 50 log lines.
 * ARGV: [1] prefix, [2] queue, [3] job id, [4] payload byte budget.
 */
export const JOB_LUA = `${PRELUDE}${JOB_FIELDS}
local prefix, q, id, dataMax = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4])
local base = prefix .. ':' .. q .. ':'
local row = jobRow(base, id, dataMax, true)
if not row then return cjson.encode({ found = false }) end
local state = 'unknown'
for _, z in ipairs({ 'completed', 'failed', 'delayed', 'prioritized', 'waiting-children' }) do
  local sc = redis.pcall('ZSCORE', base .. z, id)
  if type(sc) == 'string' then
    state = z
    break
  end
end
if state == 'unknown' then
  for _, l in ipairs({ 'active', 'wait', 'paused' }) do
    local p = redis.pcall('LPOS', base .. l, id)
    if type(p) == 'number' then state = l break end
  end
end
local logs = redis.pcall('LRANGE', base .. id .. ':logs', -50, -1)
if type(logs) ~= 'table' then logs = {} end
local logCount = num('LLEN', base .. id .. ':logs')
return cjson.encode({ found = true, state = state, job = row, logs = logs, logCount = logCount })
`;
