'use client';

import { Fragment, type MouseEvent, type TouchEvent } from 'react';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { linkifySegments, type LinkifiedLinkSegment } from '@/lib/linkify';

/**
 * User-authored text with the web addresses in it drawn as links.
 *
 * These are the ONLY two ways a stored description or memo becomes clickable.
 * Both render text nodes and anchors -- never markup from the string itself --
 * so the field stays plain text end to end: nothing is stored as HTML, no
 * sanitizer is relaxed, and the codebase's zero `dangerouslySetInnerHTML` count
 * is unchanged. What the reader sees is byte-for-byte what the writer typed;
 * only the affordance is new. `linkify.ts` holds that round trip as a test.
 *
 * `LinkifiedText` is for text being READ -- it draws the anchors in place.
 * `NoteLinks` is for text being EDITED, where that is impossible: a `<textarea>`
 * cannot contain an anchor, so the addresses are offered beneath the field
 * instead. Same parser, same anchor, so the two surfaces cannot disagree about
 * what counts as a link or how it opens.
 */

interface LinkifiedTextProps {
  /** The stored text. A caller with nothing to show renders its own fallback. */
  text: string;
}

/**
 * A register row is clickable (`useLongPress`), so an anchor inside one is a
 * control inside a row and follows the same rule as the favourite star and
 * `RowActions`: it stops the event rather than letting the row act on it.
 * Without this a tap on the link both opened the ticket page and the edit
 * modal behind it, and a press-and-hold opened the mobile action sheet on top
 * of the browser's own link menu.
 */
function stopRowActivation(event: MouseEvent | TouchEvent) {
  event.stopPropagation();
}

/**
 * The one anchor. Its label is ALWAYS the address it points at -- there is no
 * `children` to pass -- so neither surface can present one destination and
 * navigate to another, which is the property that makes autolinking safe where
 * rendering stored markup would not be.
 */
function NoteLink({
  segment,
  className,
}: {
  segment: LinkifiedLinkSegment;
  className: string;
}) {
  return (
    <a
      href={segment.href}
      target="_blank"
      rel="noopener noreferrer"
      // An address is LTR whatever the reader's locale, and isolating it stops
      // a bidi control ELSEWHERE in the note -- or in the surrounding UI -- from
      // reordering the label. `linkify.ts` keeps such characters out of the
      // label itself; this keeps them out of its rendering context. HTML's own
      // rendering rules give `[dir]` `unicode-bidi: isolate`, and the style says
      // so explicitly rather than resting on a UA stylesheet for a property the
      // label's honesty depends on.
      dir="ltr"
      style={{ unicodeBidi: 'isolate' }}
      onClick={stopRowActivation}
      onMouseDown={stopRowActivation}
      onTouchStart={stopRowActivation}
      onContextMenu={stopRowActivation}
      className={className}
    >
      {segment.value}
    </a>
  );
}

const LINK_CLASSES =
  'text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm dark:text-blue-400';

/**
 * Read-only text with its addresses anchored in place.
 *
 * No wrapper element: the caller's cell already carries the truncation, colour
 * and line-through this text is styled with, and a `<div>` of our own would
 * break `truncate` on the parent.
 */
export function LinkifiedText({ text }: LinkifiedTextProps) {
  const segments = linkifySegments(text);

  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'link' ? (
          <NoteLink key={index} segment={segment} className={LINK_CLASSES} />
        ) : (
          <Fragment key={index}>{segment.value}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * The addresses in a note the user is editing, offered beneath the field.
 *
 * A `<textarea>` renders no elements, so the link in a description was reachable
 * from the register and not from the form that owns the text -- the user had to
 * save, find the row, and click it there. This closes that: the addresses appear
 * as the text is typed and open in a new tab, leaving the draft untouched.
 *
 * Renders nothing at all when the text holds no address, so a field the user is
 * still filling in does not reserve space for a row that is not coming.
 */
export function NoteLinks({ text }: { text: string }) {
  const links = linkifySegments(text).filter(
    (segment): segment is LinkifiedLinkSegment => segment.kind === 'link',
  );
  if (links.length === 0) return null;

  return (
    <div className="mt-1 flex flex-col items-start gap-0.5">
      {links.map((segment, index) => (
        <span key={index} className="flex max-w-full items-center gap-1 text-xs">
          <ArrowTopRightOnSquareIcon
            className="h-3.5 w-3.5 flex-shrink-0 text-blue-600 dark:text-blue-400"
            aria-hidden="true"
          />
          <NoteLink segment={segment} className={`${LINK_CLASSES} truncate`} />
        </span>
      ))}
    </div>
  );
}
