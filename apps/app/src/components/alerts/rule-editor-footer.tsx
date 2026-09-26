import * as React from 'react';
import type { AlertRuleView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { EVALUATOR_TICK_SECONDS } from './rule-facts';
import { RuleDelete } from './rule-delete';

interface RuleEditorFooterProps {
  rule: AlertRuleView | null;
  dirty: boolean;
  saving: boolean;
  removing: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onDelete: () => void;
}

/**
 * Save rule is coral only while there are unsaved changes (then the header's
 * New rule steps back to outline), so the page never shows two corals.
 */
export function RuleEditorFooter({ rule, dirty, saving, removing, onSave, onDiscard, onDelete }: RuleEditorFooterProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={dirty ? 'default' : 'outline'} className="pointer-coarse:min-h-11" disabled={!dirty || saving} onClick={onSave}>
          {saving ? 'Saving…' : 'Save rule'}
        </Button>
        {rule && dirty ? (
          <Button variant="ghost" className="pointer-coarse:min-h-11" onClick={onDiscard}>
            Discard changes
          </Button>
        ) : null}
        <span className="text-muted-foreground font-mono text-[11.5px]">
          Saved rules are audited · changes apply on the next {EVALUATOR_TICK_SECONDS} s tick
        </span>
      </div>
      {rule ? <RuleDelete name={rule.name} isDefault={rule.isDefault} pending={removing} onConfirm={onDelete} /> : null}
    </div>
  );
}
