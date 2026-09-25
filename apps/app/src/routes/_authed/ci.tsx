import { createFileRoute } from '@tanstack/react-router';
import { parseGitResultSearch } from '@/components/ci/git-result-banner';
import { CiPage } from '@/components/ci/ci-page';

export const Route = createFileRoute('/_authed/ci')({
  validateSearch: parseGitResultSearch,
  component: CiPage,
});
