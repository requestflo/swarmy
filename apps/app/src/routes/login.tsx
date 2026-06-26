import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ContainerIcon, Loader2Icon } from 'lucide-react';
import { authClient } from '@swarmy/auth/client';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  toast,
} from '@swarmy/ui';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `org-${Date.now()}`;
}

function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = React.useState<'signin' | 'signup'>('signin');
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === 'signup') {
        const res = await authClient.signUp.email({ email, password, name });
        if (res.error) throw new Error(res.error.message ?? 'sign up failed');
        const org = await authClient.organization.create({
          name: `${name || email.split('@')[0]}'s team`,
          slug: slugify(name || email),
        });
        if (org.data?.id) {
          await authClient.organization.setActive({ organizationId: org.data.id });
        }
      } else {
        const res = await authClient.signIn.email({ email, password });
        if (res.error) throw new Error(res.error.message ?? 'sign in failed');
      }
      await navigate({ to: '/' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'authentication failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
            <ContainerIcon className="size-5" />
          </div>
          <span className="text-xl font-semibold tracking-tight">swarmy</span>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{mode === 'signin' ? 'Welcome back' : 'Create your account'}</CardTitle>
            <CardDescription>
              {mode === 'signin'
                ? 'Sign in to your swarmy controller'
                : 'Set up your account and first team'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4">
              {mode === 'signup' && (
                <div className="grid gap-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
                </div>
              )}
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              <Button type="submit" disabled={busy} className="w-full">
                {busy && <Loader2Icon className="animate-spin" />}
                {mode === 'signin' ? 'Sign in' : 'Create account'}
              </Button>
            </form>
            <p className="text-muted-foreground mt-4 text-center text-sm">
              {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
              >
                {mode === 'signin' ? 'Sign up' : 'Sign in'}
              </button>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
