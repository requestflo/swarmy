import { idleWords, sleptWords, type SleepSim } from './sleep-sim';

/**
 * The plain sentences beside Sleep when idle, true to how swarmy behaves: a
 * sleeping service is woken by the next request through its address (the
 * front door routes it to the waker); with no address nothing wakes it.
 * PURE — unit-tested in sleep-sim.test.ts.
 */

/** What sleeping does for this service, now. */
export function sleepNowWords({
  name,
  enabled,
  asleep,
  idleSec,
  address,
}: {
  name: string;
  enabled: boolean;
  asleep: boolean;
  idleSec: number;
  address: string | null;
}): string {
  const wake = address
    ? `The next visit to ${address} wakes it; that visit waits while a copy starts.`
    : `Nothing outside reaches ${name}, so a request can't wake it.`;
  if (asleep) return `Asleep now. ${wake}`;
  if (enabled) return `Sleeps after ${idleWords(idleSec)} with no requests. ${wake}`;
  return address
    ? `Always on, even when nobody is visiting.`
    : `Always on. It has no address, so sleeping would leave nothing to wake it.`;
}

/** The sentence under the chart: what yesterday would have looked like. */
export function sleepDayWords({
  name,
  sim,
  idleSec,
  address,
}: {
  name: string;
  sim: SleepSim;
  idleSec: number;
  address: string | null;
}): string {
  if (sim.calls === 0) {
    return `swarmy saw no requests to ${name} yesterday: it had none, or it doesn't send traces.`;
  }
  const idle = idleWords(idleSec);
  if (sim.asleepMs === 0) return `Never idle for ${idle} yesterday, so it wouldn't have slept.`;
  const naps = sim.naps === 1 ? 'one nap' : `${sim.naps} naps`;
  const slept = `With ${idle} idle, ${name} would have slept about ${sleptWords(sim.asleepMs)} yesterday, in ${naps}.`;
  if (sim.wakes === 0) return slept;
  const times = sim.wakes === 1 ? 'once' : `${sim.wakes} times`;
  return address
    ? `${slept} A request would have had to wake it ${times}.`
    : `${slept} ${sim.wakes === 1 ? 'A request' : `${sim.wakes} requests`} would have found it asleep, with no address to wake it.`;
}
