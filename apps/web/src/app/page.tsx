import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-wider text-brand-600">ConversaForge</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight text-slate-900">Practice real conversations with AI voice agents.</h1>
      <p className="mt-4 max-w-2xl text-lg text-slate-600">
        Author interview, coaching, sales, negotiation and support scenarios. Participants talk by voice; reviewers get
        transcript-grounded, rubric-based feedback and structured results.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/signup" className="rounded-md bg-brand-600 px-5 py-2.5 font-medium text-white hover:bg-brand-700">
          Create an account
        </Link>
        <Link href="/login" className="rounded-md border border-slate-300 bg-white px-5 py-2.5 font-medium text-slate-800 hover:bg-slate-50">
          Sign in
        </Link>
        <Link href="/gallery" className="rounded-md px-5 py-2.5 font-medium text-brand-700 hover:underline">
          Browse public scenarios →
        </Link>
      </div>
    </main>
  );
}
