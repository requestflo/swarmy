-- Two-factor is optional (owner decision 2026-09-24): the terminal step-up is
-- opt-in. Only the column default changes; an org that saved its terminal
-- policy keeps what it saved.
ALTER TABLE "terminal_policy" ALTER COLUMN "requireMfa" SET DEFAULT false;
