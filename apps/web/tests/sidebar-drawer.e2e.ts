/** Narrow sidebar geometry, navigation, focus and retained content in the shipped profile. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Locator } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'

/** A returning rail uses its compact layout without wide-content or icon-entry animations. */
async function assertCompactRail(sidebar: Locator): Promise<void> {
  expect(await sidebar.getByRole('button', { name: 'New session', exact: true }).count()).toBe(1)
  expect(await sidebar.evaluate((el) => {
    const root = el.firstElementChild!
    return {
      fits: root.getBoundingClientRect().width <= el.parentElement!.getBoundingClientRect().width,
      animations: root.getAnimations({ subtree: true })
        .filter((animation): animation is CSSAnimation =>
          animation instanceof CSSAnimation && /wide-in|rail-in|rail-fade-in/.test(animation.animationName))
        .map(animation => animation.animationName),
    }
  })).toEqual({ fits: true, animations: [] })
}

it('hides a collapsed rail immediately when it becomes a drawer', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 768, height: 844 }, locale: 'en-US' })
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).waitFor()
      const sidebar = page.locator('[data-slot="sidebar"]')
      const sidebarColumn = sidebar.locator('..')
      await expect.poll(async () => (await sidebarColumn.boundingBox())?.width).toBe(56)
      await sidebarColumn.evaluate((el) => {
        el.parentElement!.style.setProperty('--ds-transition-duration-slow', '100s')
      })
      await page.setViewportSize({ width: 767, height: 844 })
      await page.locator('[data-sidebar-drawer]').waitFor()
      const state = await sidebarColumn.evaluate(el => ({
        visibility: getComputedStyle(el).visibility,
        transitions: el.getAnimations().filter(animation => animation instanceof CSSTransition)
          .map(animation => animation.transitionProperty),
      }))
      expect(state).toEqual({ visibility: 'hidden', transitions: [] })
      await page.setViewportSize({ width: 768, height: 844 })
      await page.locator('[data-sidebar-drawer]').waitFor({ state: 'detached' })
      await assertCompactRail(sidebar)
      await page.setViewportSize({ width: 767, height: 844 })
      await page.locator('[data-sidebar-drawer]').waitFor()
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true })
      await drawer.waitFor()
      expect(await sidebarColumn.evaluate(el => el.getAnimations().some(animation =>
        animation instanceof CSSTransition && animation.transitionProperty === 'transform'))).toBe(true)
      await sidebarColumn.evaluate((el) => {
        for (const animation of el.parentElement!.getAnimations({ subtree: true })) animation.finish()
      })
      await drawer.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      expect(await sidebarColumn.evaluate(el => el.getAnimations().some(animation =>
        animation instanceof CSSTransition && animation.transitionProperty === 'transform'))).toBe(true)
      await sidebarColumn.evaluate((el) => {
        for (const animation of el.parentElement!.getAnimations({ subtree: true })) animation.finish()
      })
      await page.setViewportSize({ width: 768, height: 844 })
      await page.locator('[data-sidebar-drawer]').waitFor({ state: 'detached' })
      await assertCompactRail(sidebar)
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})

it('retains the closing slide when an expanded sidebar becomes a collapsed drawer', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1024, height: 844 }, locale: 'en-US' })
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor()
      const sidebarColumn = page.locator('[data-slot="sidebar"]').locator('..')
      await expect.poll(async () => (await sidebarColumn.boundingBox())?.width).toBe(280)
      await sidebarColumn.evaluate((el) => {
        el.parentElement!.style.setProperty('--ds-transition-duration-slow', '100s')
      })
      await page.setViewportSize({ width: 767, height: 844 })
      await page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').waitFor()
      expect(await sidebarColumn.evaluate(el => el.getAnimations().some(animation =>
        animation instanceof CSSTransition && animation.transitionProperty === 'transform'))).toBe(true)
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})

/** Sample the CSS fade at its midpoint without depending on the host's frame rate. */
async function assertMaskFade(frame: Locator, from: number, to: number): Promise<void> {
  const sample = await frame.locator('[data-sidebar-mask]').evaluate((el) => {
    const fade = el.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'opacity')
    if (fade === undefined || !(fade.effect instanceof KeyframeEffect)) throw new Error('Drawer mask opacity transition is missing')
    fade.pause()
    fade.currentTime = Number(fade.effect.getComputedTiming().duration) / 2
    return {
      endpoints: fade.effect.getKeyframes().map(keyframe => Number(keyframe.opacity)),
      opacity: Number(getComputedStyle(el).opacity),
    }
  })
  expect(sample.endpoints).toEqual([from, to])
  expect(sample.opacity).toBeGreaterThan(0)
  expect(sample.opacity).toBeLessThan(1)
  await frame.evaluate((el) => {
    for (const animation of el.getAnimations({ subtree: true })) {
      if (animation instanceof CSSTransition) animation.finish()
    }
    el.style.removeProperty('--ds-transition-duration-slow')
  })
}

/** Sample both width transitions on the same clock to detect detached sidebar controls. */
async function assertFoldResize(toggle: Locator, from: number, to: number): Promise<void> {
  await expect.poll(() => toggle.evaluate((button, target) => {
    const frame = button.closest<HTMLElement>('[data-animating]')
    return frame !== null && parseFloat(frame.style.gridTemplateColumns) === target && frame.getAnimations().some(animation =>
      animation instanceof CSSTransition && animation.transitionProperty === 'grid-template-columns')
  }, to)).toBe(true)
  const sample = await toggle.evaluate((button) => {
    const frame = button.closest<HTMLElement>('[data-animating]')!
    const transitions = frame.getAnimations({ subtree: true }).filter((animation): animation is CSSTransition =>
      animation instanceof CSSTransition && ['grid-template-columns', 'width'].includes(animation.transitionProperty))
    const grid = transitions.find(animation => animation.transitionProperty === 'grid-template-columns')
    if (grid === undefined) throw new Error('Fold width transition is missing')
    const at = (progress: number) => {
      for (const transition of transitions) {
        transition.pause()
        transition.currentTime = Number(transition.effect!.getComputedTiming().duration) * progress
      }
      const width = parseFloat(getComputedStyle(frame).gridTemplateColumns)
      return { width, gap: frame.getBoundingClientRect().left + width - button.getBoundingClientRect().right }
    }
    const start = at(0)
    const middle = at(0.5)
    const end = at(1)
    for (const transition of transitions) transition.finish()
    frame.style.removeProperty('--ds-transition-duration-slow')
    return { endpoints: [start.width, end.width], start, middle }
  })
  expect(sample.endpoints).toEqual([from, to])
  expect(sample.middle.width).toBeGreaterThan(Math.min(from, to))
  expect(sample.middle.width).toBeLessThan(Math.max(from, to))
  expect(sample.middle.gap).toBeCloseTo(sample.start.gap, 1)
}

it('overlays the conversation and closes after navigation without losing its sidebar content', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const seed = await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8')
    const sessionId = await seedSession(scaffold, seed, 'session-c4421b66-252e-44c0-80ed-6e320abeba25')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'Drawer navigation' })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, locale: 'en-US' })
      const console = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      const opener = page.getByRole('button', { name: 'Open sidebar', exact: true })
      await opener.waitFor()
      const frame = page.locator('[data-sidebar-drawer]')
      await expect.poll(() => frame.getAttribute('data-sidebar-collapsed')).toBe('true')
      const sidebar = page.locator('[data-slot="sidebar"]')
      const original = await sidebar.elementHandle()
      const main = page.locator('[data-slot="main"]').locator('..')
      const closed = await main.boundingBox()
      // A long test-owned duration keeps the transition available until its
      // animation clock is sampled and finished explicitly.
      await frame.evaluate((el) => { el.style.setProperty('--ds-transition-duration-slow', '100s') })
      await opener.tap()
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true })
      await drawer.waitFor()
      await assertMaskFade(frame, 0, 1)
      await expect.poll(() => main.boundingBox()).toEqual(closed)
      expect(closed?.width).toBe(390)
      expect(await main.evaluate(el => el.closest('[inert]') !== null)).toBe(true)
      expect(await page.locator('[data-side="sidebar"]').count()).toBe(0)
      const workspaceRow = drawer.locator('[data-row-key^="workspace:"]').first()
      const workspaceButtons = workspaceRow.getByRole('button', { includeHidden: true })
      expect(await workspaceRow.getAttribute('aria-expanded')).toBe('true')
      expect(await workspaceButtons.count()).toBe(2)
      for (const button of await workspaceButtons.all()) await button.waitFor()
      await workspaceRow.tap()
      expect(await workspaceRow.getAttribute('aria-expanded')).toBe('false')
      for (const button of await workspaceButtons.all()) expect(await button.isVisible()).toBe(false)
      expect(await workspaceRow.evaluate(el => el === document.activeElement)).toBe(true)
      await workspaceRow.tap()
      for (const button of await workspaceButtons.all()) await button.waitFor()
      await drawer.getByRole('button', { name: 'Search sessions', exact: true }).tap()
      const search = drawer.getByPlaceholder('Search session names')
      expect(await search.evaluate(el => getComputedStyle(el).fontSize)).toBe('16px')
      await drawer.getByRole('button', { name: 'Clear search', exact: true }).tap()
      await frame.evaluate((el) => { el.style.setProperty('--ds-transition-duration-slow', '100s') })
      await page.getByRole('treeitem').filter({ has: page.getByText('Drawer navigation', { exact: true }) }).tap()
      await assertMaskFade(frame, 1, 0)
      await drawer.waitFor({ state: 'hidden' })
      await page.getByRole('navigation', { name: 'Session hierarchy' }).getByText('Drawer navigation', { exact: true }).waitFor()
      await opener.click()
      const selectedRow = drawer.getByRole('treeitem', { selected: true })
      const more = selectedRow.getByRole('button', { name: 'Session actions for Drawer navigation', exact: true })
      await more.waitFor()
      expect(await selectedRow.getByRole('button', { name: 'Archive session', exact: true }).isVisible()).toBe(false)
      expect(await selectedRow.getByRole('button', { name: 'Pin session', exact: true }).isVisible()).toBe(false)
      expect(await selectedRow.getByRole('button').count()).toBe(1)
      await more.tap()
      const menu = page.getByRole('menu')
      await menu.getByRole('menuitem', { name: 'Archive session', exact: true }).waitFor()
      await menu.getByRole('menuitem', { name: 'Pin session', exact: true }).tap()
      await menu.waitFor({ state: 'hidden' })
      await selectedRow.getByLabel('Pinned', { exact: true }).waitFor()
      await more.tap()
      await menu.getByRole('menuitem', { name: 'Unpin session', exact: true }).tap()
      await menu.waitFor({ state: 'hidden' })
      await expect.poll(() => selectedRow.getByLabel('Pinned', { exact: true }).count()).toBe(0)
      await drawer.getByRole('button', { name: 'Plugins', exact: true }).tap()
      await drawer.waitFor({ state: 'hidden' })
      await page.locator('[data-plugin-panel]').waitFor()
      await opener.click()
      await drawer.waitFor()
      await page.touchscreen.tap(370, 420)
      await drawer.waitFor({ state: 'hidden' })
      await opener.click()
      await page.keyboard.press('Escape')
      await drawer.waitFor({ state: 'hidden' })
      expect(await opener.evaluate(el => el === document.activeElement)).toBe(true)
      expect(await sidebar.evaluate((el, previous) => el === previous, original)).toBe(true)
      await original?.dispose()

      await page.setViewportSize({ width: 768, height: 844 })
      await expect.poll(() => frame.count()).toBe(0)
      await expect.poll(async () => Math.round((await main.boundingBox())!.width)).toBe(712)
      await page.setViewportSize({ width: 767, height: 844 })
      await expect.poll(() => frame.count()).toBe(1)

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await opener.tap()
      const mask = frame.locator('[data-sidebar-mask]')
      expect(await mask.evaluate(el => getComputedStyle(el).opacity)).toBe('1')
      expect(await mask.evaluate(el => el.getAnimations().length)).toBe(0)
      await drawer.getByRole('button', { name: 'Collapse sidebar', exact: true }).tap()
      expect(await mask.evaluate(el => getComputedStyle(el).opacity)).toBe('0')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expect.poll(async () => Math.round((await main.boundingBox())!.width)).toBe(767)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(767)
      await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin' })
      await expect.poll(() => main.evaluate(el => getComputedStyle(el).paddingTop)).toBe('0px')
      await page.evaluate(() => { delete document.documentElement.dataset.platform })
      await expect.poll(() => main.evaluate(el => getComputedStyle(el).paddingTop)).toBe('48px')

      await page.setViewportSize({ width: 390, height: 844 })
      await drawer.waitFor({ state: 'hidden' })
      await opener.tap()
      await drawer.getByRole('button', { name: 'New session', exact: true }).last().tap()
      await drawer.waitFor({ state: 'hidden' })
      const home = page.locator('[data-phase="hero"]')
      await home.waitFor()
      const editor = home.locator('[contenteditable="true"]')
      await editor.tap()
      const homeEditorBox = await editor.boundingBox()
      // Chromium cannot raise a phone keyboard; simulate document panning
      // before the visual viewport publishes the matching offset.
      const restoreViewport = await page.evaluateHandle(() => {
        const viewport = window.visualViewport!
        const scrollY = Object.getOwnPropertyDescriptor(window, 'scrollY')!
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 80 })
        Object.defineProperties(viewport, {
          height: { configurable: true, value: 360 },
          offsetTop: { configurable: true, value: 0 },
        })
        viewport.dispatchEvent(new Event('resize'))
        viewport.dispatchEvent(new Event('scroll'))
        window.dispatchEvent(new Event('scroll'))
        return () => {
          Object.defineProperty(window, 'scrollY', scrollY)
          Reflect.deleteProperty(viewport, 'height')
          Reflect.deleteProperty(viewport, 'offsetTop')
          window.dispatchEvent(new Event('scroll'))
          viewport.dispatchEvent(new Event('resize'))
        }
      })
      const root = page.locator('#root')
      await expect.poll(() => root.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
      expect(await editor.boundingBox()).toEqual(homeEditorBox)
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 80 })
        window.visualViewport!.dispatchEvent(new Event('scroll'))
      })
      await expect.poll(() => root.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
      await expect.poll(async () => (await main.boundingBox())?.height).toBe(844)
      await opener.tap()
      await expect.poll(async () => (await drawer.boundingBox())?.height).toBe(844)
      const searchWithKeyboard = drawer.getByPlaceholder('Search session names')
      await drawer.getByRole('button', { name: 'Search sessions', exact: true }).tap()
      await searchWithKeyboard.tap()
      await searchWithKeyboard.fill('retained search')
      await drawer.getByRole('button', { name: 'Account menu', exact: true }).tap()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).tap()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.waitFor()
      await expect.poll(() => settings.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
      expect(await settings.locator('..').evaluate(el => getComputedStyle(el).padding)).toBe('0px')
      const closeSettings = settings.getByRole('button', { name: 'Close', exact: true })
      const closeBox = (await closeSettings.boundingBox())!
      expect(closeBox.y).toBeGreaterThanOrEqual(0)
      expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(844)
      await closeSettings.tap()
      await settings.waitFor({ state: 'hidden' })
      await expect.poll(() => searchWithKeyboard.inputValue()).toBe('retained search')
      await restoreViewport.evaluate((restore) => { restore() })
      await restoreViewport.dispose()
      await expect.poll(() => root.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
      await expect.poll(async () => (await drawer.boundingBox())?.height).toBe(844)
      // Desktop Chromium supplies zero safe-area insets; exercise the shell's
      // inset properties with the same geometry as a phone's protected edges.
      await root.evaluate((el) => {
        el.style.setProperty('--dsh-safe-area-top', '56px')
        el.style.setProperty('--dsh-safe-area-bottom', '34px')
      })
      await frame.evaluate((el) => { el.scrollLeft = 10 })
      expect(await frame.evaluate(el => el.scrollLeft)).toBe(0)
      await expect.poll(() => mask.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
      await expect.poll(() => drawer.evaluate((el) => {
        const frame = el.closest('[data-sidebar-drawer]')!
        let column = el
        while (column.parentElement !== frame) column = column.parentElement!
        const { y, height } = column.getBoundingClientRect()
        return { y, height }
      })).toEqual({ y: 0, height: 844 })
      await expect.poll(async () => {
        const box = await drawer.boundingBox()
        return { y: box?.y, height: box?.height }
      }).toEqual({ y: 56, height: 754 })
      await root.evaluate((el) => {
        el.style.removeProperty('--dsh-safe-area-top')
        el.style.removeProperty('--dsh-safe-area-bottom')
      })
      await expect.poll(async () => (await drawer.boundingBox())?.height).toBe(844)
      await page.setViewportSize({ width: 844, height: 390 })
      await expect.poll(async () => (await root.boundingBox())?.height).toBe(390)
      await expect.poll(() => frame.count()).toBe(0)
      await page.setViewportSize({ width: 390, height: 844 })
      await expect.poll(async () => (await root.boundingBox())?.height).toBe(844)
      await expect.poll(() => frame.count()).toBe(1)

      const posture = await page.context().newCDPSession(page)
      try {
        await page.setViewportSize({ width: 951, height: 669 })
        await expect.poll(() => frame.count()).toBe(0)
        await posture.send('Emulation.setDevicePostureOverride', { posture: { type: 'folded' } })
        await opener.tap()
        await expect.poll(() => main.boundingBox()).toEqual({ x: 475.5, y: 0, width: 475.5, height: 669 })
        expect(await page.locator('[data-side="sidebar"]').count()).toBe(0)
        const foldSearch = page.getByPlaceholder('Search session names')
        if (!(await foldSearch.isVisible())) await page.getByRole('button', { name: 'Search sessions', exact: true }).tap()
        await foldSearch.fill('fold search')
        const wideFrame = page.locator('[data-rightbar-collapsed]')
        const collapseSidebar = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
        await wideFrame.evaluate((el) => { el.style.setProperty('--ds-transition-duration-slow', '100s') })
        await posture.send('Emulation.clearDevicePostureOverride')
        await assertFoldResize(collapseSidebar, 475.5, 280)
        await expect.poll(() => main.boundingBox()).toEqual({ x: 280, y: 0, width: 671, height: 669 })
        expect(await page.locator('[data-side="sidebar"]').count()).toBe(1)
        expect(await foldSearch.evaluate(el => el === document.activeElement)).toBe(true)
        expect(await foldSearch.inputValue()).toBe('fold search')
        await wideFrame.evaluate((el) => { el.style.setProperty('--ds-transition-duration-slow', '100s') })
        await posture.send('Emulation.setDevicePostureOverride', { posture: { type: 'folded' } })
        await assertFoldResize(collapseSidebar, 280, 475.5)
        await expect.poll(async () => (await main.boundingBox())?.x).toBe(475.5)
        expect(await foldSearch.evaluate(el => el === document.activeElement)).toBe(true)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await posture.send('Emulation.clearDevicePostureOverride')
        await expect.poll(async () => (await main.boundingBox())?.x).toBe(280)
        expect(await wideFrame.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0)
        await posture.send('Emulation.setDevicePostureOverride', { posture: { type: 'folded' } })
        await expect.poll(async () => (await main.boundingBox())?.x).toBe(475.5)
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await page.setViewportSize({ width: 669, height: 951 })
        await expect.poll(() => frame.getAttribute('data-sidebar-collapsed')).toBe('true')
        await drawer.waitFor({ state: 'hidden' })
        await opener.tap()
        await expect.poll(async () => (await drawer.boundingBox())?.width).toBe(280)
        expect(await main.boundingBox()).toEqual({ x: 0, y: 0, width: 669, height: 951 })
      } finally {
        await posture.detach()
      }

      const pointerPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US' })
      try {
        await pointerPage.goto(scaffold.authenticatedUrl)
        await pointerPage.getByRole('button', { name: 'Open sidebar', exact: true }).click()
        expect(await pointerPage.getByPlaceholder('Search session names').evaluate(el => getComputedStyle(el).fontSize)).toBe('13px')
        const pointerWorkspace = pointerPage.locator('[data-row-key^="workspace:"]').first()
        const pointerWorkspaceButtons = pointerWorkspace.getByRole('button', { includeHidden: true })
        await pointerWorkspace.click()
        expect(await pointerWorkspace.getAttribute('aria-expanded')).toBe('false')
        const collapseSidebar = pointerPage.getByRole('button', { name: 'Collapse sidebar', exact: true })
        await collapseSidebar.focus()
        await collapseSidebar.hover()
        for (const button of await pointerWorkspaceButtons.all()) expect(await button.isVisible()).toBe(false)
        await pointerWorkspace.hover()
        for (const button of await pointerWorkspaceButtons.all()) await button.waitFor()
        await pointerWorkspace.click()
        for (const label of ['Collapse sidebar', 'View options']) {
          await pointerPage.getByRole('button', { name: label, exact: true }).hover()
          const tooltip = pointerPage.getByRole('tooltip').filter({ hasText: label })
          await tooltip.waitFor()
          expect(await tooltip.evaluate(el => el.closest('[data-slot="sidebar"]'))).toBeNull()
          const box = (await tooltip.boundingBox())!
          expect(box.x).toBeGreaterThanOrEqual(12)
          expect(box.x + box.width).toBeLessThanOrEqual(378)
        }
        const pointerRow = pointerPage.getByRole('treeitem').filter({ has: pointerPage.getByText('Drawer navigation', { exact: true }) })
        await pointerRow.click()
        await pointerPage.getByRole('dialog', { name: 'Navigation', exact: true }).waitFor({ state: 'hidden' })
        await pointerPage.getByRole('button', { name: 'Open sidebar', exact: true }).click()
        await pointerPage.getByRole('button', { name: 'Collapse sidebar', exact: true }).hover()
        await expect.poll(() => pointerRow.getByRole('button', { name: 'Session actions for Drawer navigation', exact: true }).isVisible()).toBe(false)
        await pointerRow.hover()
        for (const label of ['Session actions for Drawer navigation', 'Archive session', 'Pin session']) {
          await pointerRow.getByRole('button', { name: label, exact: true }).waitFor()
        }
        await pointerPage.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
        const pointerDrawer = pointerPage.getByRole('dialog', { name: 'Navigation', exact: true })
        await pointerDrawer.waitFor({ state: 'hidden' })
        await pointerPage.setViewportSize({ width: 767, height: 844 })
        await pointerPage.getByRole('button', { name: 'Open sidebar', exact: true }).press('Enter')
        await pointerDrawer.waitFor()
        expect(await pointerDrawer.evaluate(el => el.contains(document.activeElement))).toBe(true)
        await pointerPage.setViewportSize({ width: 768, height: 844 })
        await pointerPage.locator('[data-sidebar-drawer]').waitFor({ state: 'detached' })
        const pointerSidebar = pointerPage.locator('[data-slot="sidebar"]')
        await expect.poll(() => pointerSidebar.getByRole('button', { name: 'New session', exact: true }).count()).toBe(1)
        const railToggle = pointerSidebar.getByRole('button', { name: 'Open sidebar', exact: true })
        expect(await railToggle.evaluate(el => el === document.activeElement)).toBe(true)
      } finally {
        await pointerPage.close()
      }
      expect(console.pageErrors).toEqual([])
      expect(console.warnings).toEqual([])
      const result = [
        '390px: closed sidebar has no rail; main width 390px',
        'open: main geometry retained; background inert; no resize handle',
        'close: Session navigation, Plugins navigation, mask and Escape',
        'retained: sidebar DOM and opener focus',
        '768px: 56px rail; main width 712px; drawer focus transfers to the rail toggle',
        'breakpoint motion: collapsed rail hides immediately and returns compact without crossfades; expanded sidebar and explicit toggles retain their slides',
        '767px: hidden drawer; main width 767px; no page overflow',
        'global panels: browser top inset 48px; macOS keeps its existing clearance',
        'tooltips: sidebar and workspace controls escape the drawer and fit the viewport',
        'search input: 16px on touch; 13px with a fine pointer',
        'simulated keyboard: homepage, drawer and Settings retain 844px layout height without following the 360px visual viewport or adding safe-area padding to Settings',
        'keyboard close: layout height stays 844px; sidebar search retained; Settings close remains reachable',
        'safe areas: drawer backing and mask cover 844px; content retains 56px top and 34px bottom insets',
        'rotation: 844x390 then 390x844 restores shell height and sidebar breakpoint',
        'folded landscape: 951px frame splits at 475.5px without a resize handle; unfolding restores 280px and search focus; portrait retains the drawer',
        'fold transitions: sidebar controls follow the divider in both directions; reduced motion changes width without animation',
        'drawer mask: opacity transitions from 0 to 1 on open and 1 to 0 on close',
        'reduced motion: drawer and mask settle without transitions',
        'touch selected Session: More remains visible; archive and pin stay in its menu; pin marker retained',
        'touch Workspace: actions appear only while expanded, including after folding the focused row',
        'fine pointer: folded Workspace actions remain available on hover',
        'fine pointer: selected Session actions stay hidden until hover, including at 390px',
      ].join('\n')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/sidebar-drawer.expected.md', import.meta.url)), result, webSnapshotMode())
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
