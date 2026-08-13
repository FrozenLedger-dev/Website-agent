/**
 * Prove the scaffold compiles against the idioms a model will actually write.
 *
 *   pnpm scaffold:check
 *
 * The scaffold is the Base UI flavour of shadcn, but every shadcn example ever
 * published — and therefore everything a model has read — uses Radix spellings.
 * A mismatch is invisible until a run has already paid for a plan and a build,
 * and then presents as a P0 the repair budget grinds itself down against.
 *
 * This is the cheap version of that discovery: one probe page using every
 * primitive the builder is told exists, built exactly the way the platform
 * builds a project.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LUCIDE_ICONS } from '@statxai/agents';
import { buildSite, readBuiltFiles, scaffoldSite } from '@statxai/workspace';

const PROBE_PAGE = `import type { Metadata } from 'next';
import Link from 'next/link';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Hammer } from 'lucide-react';

export const metadata: Metadata = { title: 'Scaffold probe', description: 'Every primitive the builder is told exists.' };

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">Scaffold probe</h1>

      <Badge variant="secondary"><Hammer aria-hidden="true" /> Established 1998</Badge>
      <Badge asChild variant="outline"><Link href="/services">Badge as link</Link></Badge>

      <Button asChild size="lg"><Link href="/services">Button as link</Link></Button>
      <Button asChild variant="outline"><a href="tel:+441234567890">Button as anchor</a></Button>
      <Button variant="secondary" size="sm">Plain button</Button>

      <Separator className="my-8" />

      <Card>
        <CardHeader>
          <CardTitle>Card title</CardTitle>
          <CardDescription>Card description.</CardDescription>
        </CardHeader>
        <CardContent><p>Card body.</p></CardContent>
      </Card>

      <Accordion>
        <AccordionItem value="one">
          <AccordionTrigger>Accordion trigger</AccordionTrigger>
          <AccordionContent>Accordion content.</AccordionContent>
        </AccordionItem>
      </Accordion>

      <form className="mt-8 grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" type="text" required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="message">Message</Label>
          <Textarea id="message" name="message" rows={4} required />
        </div>
        <Button type="submit">Send</Button>
      </form>
    </main>
  );
}
`;

const SECOND_ROUTE = `export const metadata = { title: 'Services', description: 'A second route, so links resolve.' };
export default function Services() {
  return <main><h1>Services</h1></main>;
}
`;

/**
 * Every icon the builder is told exists, imported and rendered.
 *
 * A name that is not exported fails the build here rather than mid-run. The
 * list was written from the installed package, but packages move: lucide has
 * already dropped its brand marks once, which is how `Facebook` became a
 * plausible guess that does not compile.
 */
const ICON_PROBE = `import { ${LUCIDE_ICONS.join(', ')} } from 'lucide-react';

export const metadata = { title: 'Icons', description: 'Every icon the builder may import.' };

export default function IconProbe() {
  return (
    <main>
      <h1>Icons</h1>
      <p>${LUCIDE_ICONS.map((name) => `<${name} aria-hidden="true" />`).join('')}</p>
    </main>
  );
}
`;

const root = await mkdtemp(join(tmpdir(), 'statxai-scaffold-check-'));
const site = join(root, 'app');

try {
  console.log(`\n  scaffolding into ${site}`);
  await scaffoldSite(site);
  await writeFile(join(site, 'app/page.tsx'), PROBE_PAGE, 'utf8');
  await mkdir(join(site, 'app/services'), { recursive: true });
  await writeFile(join(site, 'app/services/page.tsx'), SECOND_ROUTE, 'utf8');
  await mkdir(join(site, 'app/icons'), { recursive: true });
  await writeFile(join(site, 'app/icons/page.tsx'), ICON_PROBE, 'utf8');

  console.log('  installing and building (this takes a minute)…\n');
  const built = await buildSite(site);

  if (!built.ok) {
    console.error(`\n\x1b[31m  ✗ the scaffold does not compile against these idioms\x1b[0m\n`);
    console.error(built.output);
    process.exit(1);
  }

  const files = await readBuiltFiles(site);
  const home = files.find((f) => f.path === 'index.html')?.contents ?? '';

  // `asChild` must produce a real anchor. Rendering <button><a> instead would
  // type-check, build, and ship invalid, unnavigable markup.
  const nested = /<button[^>]*>\s*<a\b/.test(home);
  const anchors = (home.match(/<a\b/g) ?? []).length;

  console.log(`\x1b[32m  ✓ builds in ${(built.durationMs / 1000).toFixed(1)}s — ${files.length} files exported\x1b[0m`);
  console.log(`  ${LUCIDE_ICONS.length} icon names resolve against the pinned lucide-react`);
  console.log(`  ${anchors} anchors rendered, nested interactive elements: ${nested ? 'YES' : 'none'}`);

  if (nested || anchors === 0) {
    console.error('\n\x1b[31m  ✗ asChild did not render a real anchor\x1b[0m');
    process.exit(1);
  }
  console.log('\n  The scaffold accepts every documented idiom.\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
