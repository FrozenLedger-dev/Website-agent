'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CustomerCreateEligibleAccount, CustomerProjectCreateAccepted, CustomerProjectCreateError } from '@statxai/customer-editor';

interface ServiceRow {
  name: string;
  description: string;
}

const ERROR_TEXT: Record<CustomerProjectCreateError, string> = {
  unauthenticated: 'Please sign in again.',
  forbidden: 'You do not have permission to create a website in that account.',
  invalid_request: 'Please check the business details below — something is missing or too short.',
  account_required: 'Choose which account this website belongs to.',
  too_many_active: 'You already have a website generating. Wait for it to finish before starting another.',
};

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

export function NewProjectForm({ accounts }: { readonly accounts: readonly CustomerCreateEligibleAccount[] }) {
  const router = useRouter();
  const [accountId, setAccountId] = useState(accounts.length === 1 ? accounts[0]!.accountId : '');
  const [businessName, setBusinessName] = useState('');
  const [industry, setIndustry] = useState('');
  const [location, setLocation] = useState('');
  const [audience, setAudience] = useState('');
  const [services, setServices] = useState<ServiceRow[]>([{ name: '', description: '' }]);
  const [differentiators, setDifferentiators] = useState('');
  const [tone, setTone] = useState('');
  const [goals, setGoals] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const setServiceField = (index: number, field: keyof ServiceRow, value: string) => {
    setServices((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };
  const addService = () => setServices((rows) => (rows.length >= 10 ? rows : [...rows, { name: '', description: '' }]));
  const removeService = (index: number) => setServices((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== index)));

  const validationError = useCallback((): string | null => {
    if (accounts.length > 1 && !accountId) return 'Choose which account this website belongs to.';
    if (!businessName.trim()) return 'Enter the business name.';
    if (!industry.trim()) return 'Enter the industry.';
    if (!location.trim()) return 'Enter the business location.';
    if (!audience.trim()) return 'Describe who this website is for.';
    const cleanServices = services.map((s) => ({ name: s.name.trim(), description: s.description.trim() })).filter((s) => s.name && s.description);
    if (cleanServices.length === 0) return 'Add at least one service with a name and a short description.';
    const cleanDifferentiators = splitLines(differentiators);
    if (cleanDifferentiators.length === 0) return 'Add at least one thing that sets this business apart, one per line.';
    if (!tone.trim()) return 'Describe the tone this website should have.';
    const cleanGoals = splitLines(goals);
    if (cleanGoals.length === 0) return 'Add at least one goal for this website, one per line.';
    if (!email.includes('@')) return 'Enter a contact email address.';
    if (digitsOf(phone).length < 7) return 'Enter a contact phone number.';
    return null;
  }, [accountId, accounts.length, audience, businessName, differentiators, email, goals, industry, location, phone, services, tone]);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting.current) return;
      const problem = validationError();
      if (problem) {
        setError(problem);
        return;
      }
      submitting.current = true;
      setBusy(true);
      setError(null);
      try {
        const intake = {
          businessName: businessName.trim(),
          industry: industry.trim(),
          location: location.trim(),
          audience: audience.trim(),
          services: services.map((s) => ({ name: s.name.trim(), description: s.description.trim() })).filter((s) => s.name && s.description),
          differentiators: splitLines(differentiators),
          contact: { email: email.trim(), phone: phone.trim() },
          tone: tone.trim(),
          goals: splitLines(goals),
        };
        const response = await fetch('/api/projects', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(accounts.length > 1 ? { accountId, intake } : { intake }),
        });
        if (response.status === 202) {
          const accepted = (await response.json()) as CustomerProjectCreateAccepted;
          router.push(`/projects/${encodeURIComponent(accepted.projectId)}/generating`);
          return;
        }
        if (response.status === 401) {
          window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent('/projects/new')}`);
          return;
        }
        const body = (await response.json().catch(() => ({}))) as { error?: CustomerProjectCreateError };
        setError((body.error && ERROR_TEXT[body.error]) ?? 'This website could not be created right now. Please try again.');
      } catch {
        setError('This website could not be created right now. Please try again.');
      } finally {
        submitting.current = false;
        setBusy(false);
      }
    },
    [accountId, accounts.length, audience, businessName, differentiators, email, goals, industry, location, phone, router, services, tone, validationError],
  );

  return (
    <form onSubmit={submit} noValidate>
      {accounts.length > 1 ? (
        <div className="field">
          <label htmlFor="accountId">Account</label>
          <select id="accountId" value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
            <option value="" disabled>
              Choose an account
            </option>
            {accounts.map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {account.displayName}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="field field-primary">
        <label htmlFor="businessName">What&apos;s the business called, and what does it do?</label>
        <input id="businessName" value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Business name" required maxLength={200} />
        <input id="industry" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Industry, e.g. bakery, law firm, landscaping" required maxLength={200} />
      </div>

      <div className="field">
        <label htmlFor="location">Where is it located?</label>
        <input id="location" value={location} onChange={(e) => setLocation(e.target.value)} required maxLength={200} />
      </div>

      <div className="field">
        <label htmlFor="audience">Who is this website for?</label>
        <input id="audience" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="e.g. local homeowners, small business owners" required maxLength={400} />
      </div>

      <fieldset className="field">
        <legend>Services</legend>
        {services.map((row, index) => (
          <div key={index} className="service-row">
            <input aria-label={`Service ${index + 1} name`} value={row.name} onChange={(e) => setServiceField(index, 'name', e.target.value)} placeholder="Service name" maxLength={200} />
            <input aria-label={`Service ${index + 1} description`} value={row.description} onChange={(e) => setServiceField(index, 'description', e.target.value)} placeholder="Short description" maxLength={400} />
            {services.length > 1 ? (
              <button type="button" onClick={() => removeService(index)} aria-label={`Remove service ${index + 1}`}>
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {services.length < 10 ? (
          <button type="button" onClick={addService}>
            Add another service
          </button>
        ) : null}
      </fieldset>

      <div className="field">
        <label htmlFor="differentiators">What sets this business apart? One per line.</label>
        <textarea id="differentiators" value={differentiators} onChange={(e) => setDifferentiators(e.target.value)} rows={3} maxLength={2000} />
      </div>

      <div className="field">
        <label htmlFor="tone">What tone should the website have?</label>
        <input id="tone" value={tone} onChange={(e) => setTone(e.target.value)} placeholder="e.g. warm and welcoming, bold and modern" required maxLength={200} />
      </div>

      <div className="field">
        <label htmlFor="goals">What should this website accomplish? One per line.</label>
        <textarea id="goals" value={goals} onChange={(e) => setGoals(e.target.value)} rows={3} maxLength={2000} />
      </div>

      <div className="field">
        <label htmlFor="email">Contact email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} />
      </div>

      <div className="field">
        <label htmlFor="phone">Contact phone</label>
        <input id="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required maxLength={50} />
      </div>

      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}

      <button type="submit" className="button" disabled={busy} aria-busy={busy}>
        {busy ? 'Creating…' : 'Create website'}
      </button>
    </form>
  );
}
