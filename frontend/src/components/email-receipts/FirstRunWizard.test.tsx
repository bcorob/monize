import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { FirstRunWizard } from './FirstRunWizard';
import { makeOverview } from './email-receipts-fixtures';

describe('FirstRunWizard', () => {
  it('starts at the mailbox when none is connected', () => {
    render(<FirstRunWizard overview={makeOverview({ mailbox: null })} stored={0} />);
    expect(screen.getByRole('heading', { name: 'Get started with email receipts' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect a mailbox' })).toHaveAttribute('href', '/email-receipts?tab=mailbox');
    // Only the step to do now carries its own button, besides the pointer to the review inbox.
    expect(screen.queryByRole('link', { name: 'Open the profiles' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the review inbox' })).toHaveAttribute('href', '/ai-reviews?kind=email_receipt');
  });

  it('moves on to fetching emails once the mailbox is connected', () => {
    render(<FirstRunWizard overview={makeOverview()} stored={0} />);
    expect(screen.queryByRole('link', { name: 'Connect a mailbox' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the emails' })).toHaveAttribute('href', '/email-receipts?tab=emails');
    expect(screen.getByText('(done)')).toBeInTheDocument();
  });

  it('does not count a disconnected mailbox as connected', () => {
    const overview = makeOverview();
    render(<FirstRunWizard overview={{ ...overview, mailbox: { ...overview.mailbox!, connected: false } }} stored={5} />);
    expect(screen.getByRole('link', { name: 'Connect a mailbox' })).toBeInTheDocument();
  });

  it('asks for a profile once emails are stored', () => {
    render(<FirstRunWizard overview={makeOverview()} stored={4} />);
    expect(screen.getByRole('link', { name: 'Open the profiles' })).toHaveAttribute('href', '/email-receipts?tab=profiles');
  });

  it('is gone once a mailbox, an email and an approved profile exist', () => {
    const { container } = render(
      <FirstRunWizard overview={makeOverview({ parsers: { approved: 1, draft: 0 } })} stored={4} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does not count a draft profile as done', () => {
    render(<FirstRunWizard overview={makeOverview({ parsers: { approved: 0, draft: 2 } })} stored={4} />);
    expect(screen.getByRole('link', { name: 'Open the profiles' })).toBeInTheDocument();
  });
});
