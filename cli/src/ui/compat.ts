/**
 * Compatibility re-exports (#106 → #113). `CardView` was the first Ink component written, in
 * `lib/ui.tsx`, before the component collection existed. It is the same element as `Card`; the alias is
 * kept only so the seam's original tests keep importing from one place while screens migrate.
 * Delete when the last import of `CardView` is gone.
 */
export { Card as CardView } from './components.js'
