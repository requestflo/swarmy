import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui/components/button';
import { MarketingLayout } from './marketing-layout';

export function NotFound() {
  return (
    <MarketingLayout>
      <section className="mesh">
        <div className="mx-auto max-w-2xl px-6 py-32 text-center">
          <p className="mono-label">404</p>
          <h1 className="headline mt-4 text-4xl sm:text-5xl">
            That page <em>isn't here</em>.
          </h1>
          <p className="text-muted-foreground mt-5">
            It may have moved into the docs. Try the search there, or start from the top.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Button asChild>
              <Link to="/">Home</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/docs/$" params={{ _splat: '' }}>
                Docs
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
