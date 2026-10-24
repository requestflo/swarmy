import * as React from 'react';
import { parseAppConfig } from '@swarmy/app-config';
import { CodeView, Say, SayHeader } from '@/components/calm';
import type { GitApp } from '@/components/gitops/gitops-types';
import { ComposePanel } from './compose-panel';
import { EditorToolbar, type FileTab } from './editor-toolbar';
import { fixFor, type Fix } from './fixes';
import { graphWords, LiveGraph } from './live-graph';
import { ProblemsList } from './problems-list';
import { SourceActions } from './source-actions';
import { sourceCodeTabs } from './source-code';
import { SourceFacts } from './source-facts';
import type { ConfigFileView } from './use-config-file';
import { useYamlDraft } from './use-yaml-draft';
import { YamlEditor, type EditorRequest } from './yaml-editor';

/**
 * The swarmy.yaml editor (board YamlEditor) for a git app: the file at the
 * commit swarmy last planned, checked as you type by the controller's own
 * parser, the graph of what it builds and how an edit changes it, and where
 * it lives. A scratchpad — swarmy has no way to write to git, so you carry
 * the change to your repo and push it.
 */
export function YamlWorkspace({ stack, app, branch, file, text }: { stack: string; app: GitApp; branch: string; file: ConfigFileView; text: string }): React.JSX.Element {
  const d = useYamlDraft(text);
  const [tab, setTab] = React.useState<FileTab>('yaml');
  const [request, setRequest] = React.useState<EditorRequest | null>(null);
  const [announce, setAnnounce] = React.useState('');
  const seq = React.useRef(0);
  const fixOf = React.useCallback((i: Parameters<typeof fixFor>[0]) => fixFor(i, d.text), [d.text]);
  const go = (line: number, fix?: Fix): void => {
    setTab('yaml');
    seq.current += 1;
    setRequest({ seq: seq.current, line, ...(fix ? { fix } : {}) });
  };
  const validate = (): void => {
    const issues = parseAppConfig(d.text).issues;
    const errors = issues.filter((i) => i.severity === 'error');
    const first = errors[0] ?? issues[0];
    setAnnounce(errors.length ? `${errors.length} problem${errors.length === 1 ? '' : 's'}${first?.line ? `, the first on line ${first.line}` : ''}.` : `Valid against schema v1${issues.length ? `, with ${issues.length} warning${issues.length === 1 ? '' : 's'}` : ''}.`);
    if (first?.line) go(first.line);
  };
  const errors = d.parsed.issues.filter((i) => i.severity === 'error').length;
  const source = `${app.fullName ?? 'the repo'}@${branch} · ${file.sha.slice(0, 7)}`;

  return (
    <div className="flex flex-col gap-5 pb-24 lg:pb-12">
      <SayHeader
        size="md"
        title={
          errors ? (
            <>
              {stack}’s swarmy.yaml has <Say tone="bad">{errors === 1 ? 'a problem' : `${errors} problems`}</Say>. <em>Fix {errors === 1 ? 'it' : 'them'} before you push.</em>
            </>
          ) : d.dirty ? (
            <>
              Your edit checks out. <em>Push it and swarmy applies it.</em>
            </>
          ) : (
            <>
              {stack} runs from swarmy.yaml. <em>Try a change here first.</em>
            </>
          )
        }
        lede={`${d.graph ? graphWords(d.graph) : 'The file'}, from ${source}. Checked as you type, with the same parser swarmy runs on every push.`}
        actions={<SourceActions app={app} branch={branch} />}
      />
      <EditorToolbar tab={tab} onTab={setTab} branch={branch} sha={file.sha} issues={d.parsed.issues} dirty={d.dirty} onValidate={validate} announce={announce} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className={tab === 'yaml' ? undefined : 'hidden'}>
            <YamlEditor value={d.text} onChange={d.setText} issues={d.parsed.issues} marks={d.marks} request={request} fixOf={fixOf} />
          </div>
          {tab === 'compose' ? <ComposePanel stack={stack} dirty={d.dirty} /> : null}
          <ProblemsList issues={d.parsed.issues} fixOf={fixOf} onJump={(l) => go(l)} onFix={(f) => go(f.line, f)} />
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <CodeView tabs={sourceCodeTabs(app.repoId, file.path, branch)} note="Lives in your repo’s swarmy.yaml. A push applies it; nothing here writes to git." />
          <LiveGraph graph={d.graph} diff={d.diff} dirty={d.dirty} old={d.graphIsOld} onUndo={d.reset} />
          <SourceFacts app={app} branch={branch} file={file} saved={d.savedConfig} />
        </aside>
      </div>
    </div>
  );
}
