# Composer overlap: proposed fixes

The screenshot suggests the floating composer covers the final lines of a response. Adding our rows above the input increases the floating region's height, while Claude may still reserve only the space required by its original composer. This is a likely cause; the exact scroll-container structure needs checking on the affected page.

Removing the token summary reduces the height immediately. Version 2.1.5 adds a 40px visual fade above the quota row to soften the transition; it does not alter transcript scroll clearance. The following layout changes remain proposals.

## Recommended: reserve the actual composer height

Keep the quota row near the input. Measure the complete floating composer (including the quota row and footer) with ResizeObserver. Ensure the conversation's scrollable content has enough real bottom space for that measured height plus a small gap, accounting for space Claude already reserves.

- Use real padding or a spacer in the transcript; scroll-padding alone cannot create enough scrollable space.
- Recalculate when the editor expands, controls reflow, the window resizes or the quota row wraps.
- Keep the reader's position stable when they are reviewing earlier messages. Follow new content only when they were already at the bottom.
- Restore the previous spacing when navigating away or removing the widget. Avoid double-counting Claude's existing bottom clearance.
- Verify both wheel scrolling and the jump-to-latest button can reveal the entire final line above the composer.

This fixes the overlap while preserving the current full quota display, at the cost of depending on the page's transcript/scroll-container structure.

## Alternative: quota row inside the existing composer

Put a short `Session 40% · Weekly 20%` strip inside the composer card, with reset times in the tooltips. Reserve its room within the card rather than floating it over text or controls. This is more compact but leaves less room for the editor, and any increase in the card's total height still requires correct transcript clearance.

## Lowest footprint: collapsible quota chip

Show a small `Quota` chip in an existing toolbar slot and reveal the detailed bars in a popover. This adds almost no permanent height and avoids a second row, but usage is less visible at a glance. Fall back to a separate accessible button when there is no free toolbar space.
