import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import { render } from '@/test/render';
import { BondProgramSelect, useBondProgramPicker } from './BondProgramSelect';
import { investmentsApi } from '@/lib/investments';

vi.mock('@/lib/investments', () => ({
  investmentsApi: { listBondPrograms: vi.fn() },
}));

const list = vi.mocked(investmentsApi.listBondPrograms);
const edo = { id: 'p-edo', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'EDO', currency: 'PLN', seriesCount: 3, newestSeriesCode: 'EDO1036' };

function Harness({ selected = '', currency = 'PLN' }: { selected?: string; currency?: string }) {
  const picker = useBondProgramPicker(true, currency, selected);
  return (
    <>
      <BondProgramSelect picker={picker} onChange={() => undefined} />
      <output data-testid="effective">{picker.effectiveProgramId}</output>
      <output data-testid="mismatch">{picker.mismatchedLinkCurrency ?? ''}</output>
    </>
  );
}

async function mount(props: { selected?: string; currency?: string } = {}) {
  await act(async () => {
    render(<Harness {...props} />);
  });
}

describe('BondProgramSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue([edo]);
  });

  it('labels each program by its translated name', async () => {
    await mount();
    const select = screen.getByLabelText('Bond kind');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Not linked',
      'EDO: 10-year inflation-indexed savings bonds',
    ]);
  });

  it('keeps a selected link that the loaded catalog does not hold out of the submitted value', async () => {
    await mount({ selected: 'p-gone' });
    expect(screen.getByTestId('effective')).toHaveTextContent('');
  });

  it('keeps the link visible, as the current one, while the catalog has not loaded', async () => {
    list.mockReturnValue(new Promise(() => undefined));
    await mount({ selected: 'p-edo' });
    expect(screen.getByTestId('effective')).toHaveTextContent('p-edo');
    expect(
      within(screen.getByLabelText('Bond kind')).getAllByRole('option').map((o) => o.textContent),
    ).toEqual(['Not linked', 'Linked bond kind']);
  });

  it('reports the program\'s currency when the form\'s currency is another', async () => {
    await mount({ selected: 'p-edo', currency: 'USD' });
    expect(screen.getByTestId('mismatch')).toHaveTextContent('PLN');
    expect(screen.getByRole('alert')).toHaveTextContent('linked to a bond kind in PLN');
  });
});
