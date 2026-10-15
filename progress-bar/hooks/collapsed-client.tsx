// A press target on the desktop: a surface module drawn by a `Client` laid
// over an Svg (the collapsed ring square, or the expanded row's collapse
// chevron). A surface module draws with the terminal's table less
// Client/Raster/Image, so no Svg here: the picture is the Svg beneath; this
// region only takes the click (and Enter once focused) and posts
// `{ action }` (default `'expand'`) to the hooks module, whose `ui.message`
// hook collapses or reopens the bar. No `$` here.
import type { ClientModule } from 'claude-code'

/** What register.tsx hands the instance. */
export type CollapsedClientProps = { alt: string; action?: 'expand' | 'collapse' }

const PressRegion: ClientModule<CollapsedClientProps> = (props, surface) => {
  const { Box, Text } = surface.elements
  // register.tsx's `ui.message` hook checks this exact shape.
  const press = (): void => surface.post({ action: props.action ?? 'expand' })
  // One listener each; a later call replaces the earlier one, so setting them
  // on every draw is safe and needs no local state.
  surface.onPointer(ev => {
    if (ev.type === 'up' && (ev.button === undefined || ev.button === 'left')) press()
  })
  surface.onKey(ev => {
    if (ev.key === 'return' || ev.key === ' ') press()
  })
  // Transparent: one blank cell filling the region, so the Svg beneath shows.
  return (
    <Box width="100%" height="100%">
      <Text> </Text>
    </Box>
  )
}

export default PressRegion
