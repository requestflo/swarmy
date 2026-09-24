/**
 * Shared page states. Every route paints one of these instead of a fake zero:
 * unknown is a skeleton, a failure is an ErrorState with retry, and an empty
 * collection is an EmptyState that sells the next action.
 */
export { CardSkeleton, TextSkeleton } from './card-skeleton';
export { ErrorState, PageError } from './error-state';
export { HeaderSkeleton, PageSkeleton, SkeletonBody, type PageSkeletonVariant } from './page-skeleton';
export { EmptyState } from '@swarmy/ui';
