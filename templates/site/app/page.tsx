/**
 * Placeholder homepage.
 *
 * Terra overwrites this. It is deliberately empty of business content so that
 * if generation fails, the deterministic gates reject the site rather than
 * shipping a plausible-looking template page.
 */
export default function Page() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Not yet generated</h1>
    </main>
  );
}
