import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { LinkifiedText, NoteLinks } from './LinkifiedText';

describe('LinkifiedText', () => {
  it('draws an anchor around the address and leaves the prose alone', () => {
    render(<LinkifiedText text="Event tickets https://tix.test/a8Fq2 for two" />);
    const link = screen.getByRole('link', { name: 'https://tix.test/a8Fq2' });
    expect(link.getAttribute('href')).toBe('https://tix.test/a8Fq2');
  });

  it('opens in a new tab without handing the opener over', () => {
    // `noopener` is the security half: without it the opened page can navigate
    // this one through `window.opener`, and the writer of a description is not
    // always the person reading it.
    render(<LinkifiedText text="https://tix.test/a" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('isolates the label from the direction of the text around it', () => {
    // Keeping bidi controls out of the label is half of it: an unterminated
    // override EARLIER in the note -- or in the surrounding UI, which is RTL in
    // several supported locales -- would otherwise reorder the label too. An
    // address is LTR whatever the reader's locale.
    render(<LinkifiedText text="https://tix.test/a" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('dir')).toBe('ltr');
    expect(link.style.unicodeBidi).toBe('isolate');
  });

  it('draws no link around an address carrying a bidi override', () => {
    // The label and the href are one string, so a character that changes how
    // the label RENDERS makes the two disagree about the destination while
    // still comparing equal. See linkify.test.ts for the full set.
    const { container } = render(
      <LinkifiedText text={'https://evil.test/\u202Emoc.knab//:sptth'} />,
    );
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://evil.test/');
    expect(link?.textContent).toBe('https://evil.test/');
    expect(container.textContent).toBe('https://evil.test/\u202Emoc.knab//:sptth');
  });

  it('renders exactly the text it was given', () => {
    // The visible string is unchanged by linkifying -- only the affordance is
    // new. A renderer that dropped or rewrote a character would be editing a
    // person's record of what they bought.
    const text = 'Tickets (https://tix.test/a) x2, seat 14B.';
    const { container } = render(<LinkifiedText text={text} />);
    expect(container.textContent).toBe(text);
  });

  it('interprets no markup found in the text', () => {
    // Angle brackets are stripped on write, so this shape only reaches the
    // renderer from a legacy or imported row -- and it still has to arrive as
    // text. Nothing here turns a stored string into elements.
    const text = '<a href="https://evil.test">click</a> <img src=x onerror=alert(1)>';
    const { container } = render(<LinkifiedText text={text} />);
    expect(container.textContent).toBe(text);
    expect(container.querySelector('img')).toBeNull();
    // The address inside the literal markup is still autolinked, because it is
    // an address in the text -- but as itself, labelled with its own value.
    expect(screen.getByRole('link').textContent).toBe('https://evil.test');
  });

  it('never labels a link with anything but its own destination', () => {
    // The property that makes autolinking safe where stored markup is not: the
    // label is always the address, so a description can never present one
    // destination and navigate to another. There is no `<a href=x>Refund</a>`
    // to write, because the label is not an input to this renderer.
    const texts = [
      'Refund https://evil.test/steal',
      '<a href="https://evil.test">Your bank</a>',
      '[Your bank](https://evil.test)',
      'https://bank.test@evil.test/login',
      'https://evil.test/\u202Emoc.knab//:sptth',
      '\u202Ehttps://evil.test/x',
      'Click https://evil.test/a then https://evil.test/b',
    ];
    for (const text of texts) {
      const { container, unmount } = render(<LinkifiedText text={text} />);
      for (const link of container.querySelectorAll('a')) {
        expect(link.textContent, text).toBe(link.getAttribute('href'));
        // Equal as strings is not the whole claim -- see the bidi case above.
        // The label must also RENDER as its destination, which it cannot do
        // while carrying a character that reorders or hides part of itself.
        expect(
          /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/.test(
            link.textContent ?? '',
          ),
          text,
        ).toBe(false);
      }
      unmount();
    }
  });

  it('draws no link for a scheme that would run something on click', () => {
    const { container } = render(<LinkifiedText text="javascript:alert(1)" />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toBe('javascript:alert(1)');
  });

  it('renders plain text with no anchor at all', () => {
    const { container } = render(<LinkifiedText text="Coffee with Sam" />);
    expect(container.textContent).toBe('Coffee with Sam');
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('links every address in the text', () => {
    render(<LinkifiedText text="https://a.test/1 and https://b.test/2" />);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  describe('inside a clickable row', () => {
    /**
     * The register's `<tr>` carries `useLongPress` handlers, so an anchor in the
     * description cell is a control inside a row: it must stop the event rather
     * than let the row act on it. Without this a tap opened the ticket page AND
     * the edit modal, and a press-and-hold raised the action sheet over the
     * browser's own link menu.
     */
    function renderInRow() {
      const onClick = vi.fn();
      const onMouseDown = vi.fn();
      const onTouchStart = vi.fn();
      const onContextMenu = vi.fn();
      render(
        <div
          onClick={onClick}
          onMouseDown={onMouseDown}
          onTouchStart={onTouchStart}
          onContextMenu={onContextMenu}
        >
          <LinkifiedText text="Tickets https://tix.test/a" />
        </div>,
      );
      return {
        link: screen.getByRole('link'),
        onClick,
        onMouseDown,
        onTouchStart,
        onContextMenu,
      };
    }

    it('does not fire the row action when the link is clicked', () => {
      const { link, onClick } = renderInRow();
      fireEvent.click(link);
      expect(onClick).not.toHaveBeenCalled();
    });

    it('does not start the row long-press when the link is pressed', () => {
      const { link, onMouseDown, onTouchStart } = renderInRow();
      fireEvent.mouseDown(link);
      fireEvent.touchStart(link);
      expect(onMouseDown).not.toHaveBeenCalled();
      expect(onTouchStart).not.toHaveBeenCalled();
    });

    it('leaves a right-click on the link to the browser', () => {
      const { link, onContextMenu } = renderInRow();
      fireEvent.contextMenu(link);
      expect(onContextMenu).not.toHaveBeenCalled();
    });

    it('still lets a click on the surrounding text reach the row', () => {
      // Stopping too much would make the description cell dead area, which is
      // the mistake the row-click rule warns about.
      const { onClick } = renderInRow();
      fireEvent.click(screen.getByText(/Tickets/));
      expect(onClick).toHaveBeenCalled();
    });
  });
});

describe('NoteLinks', () => {
  /**
   * The affordance for a note being EDITED. A `<textarea>` renders no elements,
   * so the address in a draft was reachable only after saving and finding the
   * row in the register. These sit under the field instead.
   */

  it('offers each address in the text', () => {
    render(<NoteLinks text="Tickets https://tix.test/a and https://tix.test/b" />);
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://tix.test/a',
      'https://tix.test/b',
    ]);
  });

  it('renders nothing when the note holds no address', () => {
    // A field the user is still filling in must not reserve space for a row
    // that is not coming.
    const { container } = render(<NoteLinks text="Coffee with Sam" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty note', () => {
    const { container } = render(<NoteLinks text="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not repeat the prose around the address', () => {
    // It lists destinations; the text itself is in the field above, and showing
    // it twice would read as a second copy of what the user is typing.
    const { container } = render(<NoteLinks text="Concert tickets https://tix.test/a for two" />);
    expect(container.textContent).toBe('https://tix.test/a');
  });

  it('opens in a new tab without handing the opener over', () => {
    render(<NoteLinks text="https://tix.test/a" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('draws no link for a scheme that would run something on click', () => {
    const { container } = render(<NoteLinks text="javascript:alert(1)" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels each link with its own destination', () => {
    // The same property the read-only renderer has, and for the same reason:
    // there is no label to supply, so none can disagree with the href.
    const { container } = render(
      <NoteLinks text='<a href="https://evil.test">Your bank</a>' />,
    );
    for (const link of container.querySelectorAll('a')) {
      expect(link.textContent).toBe(link.getAttribute('href'));
    }
  });

  it('agrees with the read-only renderer about what is a link', () => {
    // One parser, one anchor. If these ever diverge, an address is clickable on
    // one surface and inert on the other for the same stored text.
    const text = 'Tickets (https://tix.test/a). Also www.tix.test and javascript:x';
    const inList = render(<NoteLinks text={text} />);
    const listed = [...inList.container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    inList.unmount();
    const inProse = render(<LinkifiedText text={text} />);
    const anchored = [...inProse.container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(listed).toEqual(anchored);
    expect(listed).toEqual(['https://tix.test/a']);
  });
});
