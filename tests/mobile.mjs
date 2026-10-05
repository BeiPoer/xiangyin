import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startServer, client, credentials } from './helpers.mjs';

const server = await startServer();
let browser;
try {
  const api = await client(server);
  await api('/login', 'POST', credentials);
  for (let i = 0; i < 30; i++) {
    const result = await api('/words', 'POST', { text: `练习词${i}`, note: '手机滚动测试', favorite: true });
    expect(result.status).toBe(200);
  }
  const manifestResponse = await fetch(`${server.url}/manifest.webmanifest`);
  expect(manifestResponse.headers.get('content-type')).toContain('application/manifest+json');
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe('standalone');
  for (const image of [...manifest.icons, { src: '/apple-touch-icon.png', sizes: '180x180' }]) {
    const response = await fetch(`${server.url}${image.src}`);
    expect(response.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.readUInt32BE(16)).toBe(Number(image.sizes.split('x')[0]));
  }
  browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel('账号', { exact: true }).fill(credentials.username);
  await page.getByLabel('密码', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: '进入我的词库' }).click();
  await expect(page.locator('.word-card')).toHaveCount(30);
  await page.getByRole('button', { name: '添加到主屏幕' }).click();
  await expect(page.locator('#install-dialog')).toBeVisible();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/mobile-install-guide.png' });
  await page.getByRole('button', { name: '关闭添加指南' }).click();
  await page.getByRole('button', { name: '我的收藏', exact: true }).click();
  await page.getByLabel('搜索字词或备注').fill('练习词');
  await page.locator('h1').click();
  await page.locator('#main').evaluate(el => { el.scrollTop = 850; });
  const scrollTop = await page.locator('#main').evaluate(el => el.scrollTop);
  const header = await page.locator('.topbar').boundingBox();
  const nav = await page.locator('.bottom-nav').boundingBox();
  expect(scrollTop).toBeGreaterThan(500);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole('link', { name: '温习一下' }).click();
  await expect(page.getByRole('heading', { name: '温习一下。' })).toBeVisible();
  await page.getByRole('link', { name: '我的词库', exact: true }).click();
  await expect(page.getByLabel('搜索字词或备注')).toHaveValue('练习词');
  await expect(page.getByRole('button', { name: '我的收藏', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('#main').evaluate(el => el.scrollTop)).toBe(scrollTop);
  expect(await page.locator('.topbar').boundingBox()).toEqual(header);
  expect(await page.locator('.bottom-nav').boundingBox()).toEqual(nav);
  await page.evaluate(() => { window.retainedSearch = document.querySelector('#search'); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForResponse(response => response.url().endsWith('/api/review'));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.retainedSearch === document.querySelector('#search'))).toBe(true);
  await page.locator('#main').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.screenshot({ path: 'test-results/mobile-fixed-navigation.png' });
  await expect(page.getByRole('button', { name: '查看或编辑：练习词0', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '查看或编辑：练习词0', exact: true }).click();
  await page.getByLabel('释义或备注').fill('保持输入和保存按钮可见。'.repeat(30));
  // Simulate only the visual viewport shrinking, as with an on-screen keyboard.
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 400 });
    Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 30 });
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('body')).toHaveClass(/keyboard-open/);
  await expect.poll(async () => (await page.locator('#save-word').boundingBox()).y + (await page.locator('#save-word').boundingBox()).height).toBeLessThanOrEqual(430);
  const field = await page.locator('#word-note').boundingBox();
  expect(field.y).toBeGreaterThanOrEqual(30);
  await page.screenshot({ path: 'test-results/mobile-keyboard-layout.png' });
  await page.getByRole('button', { name: '保存词条', exact: true }).click();
  await expect(page.locator('#editor')).not.toBeVisible();
  await page.evaluate(() => {
    delete visualViewport.height; delete visualViewport.offsetTop;
    visualViewport.dispatchEvent(new Event('resize'));
  });
  for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: '查看或编辑：练习词0', exact: true }).click();
    await expect(page.locator('#save-word')).toBeInViewport();
    expect(await page.locator('#editor').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
  }
  expect(errors).toEqual([]);
  console.log('手机体验验证通过：主屏幕资源、固定导航、页面状态保留、无变化不重绘、模拟键盘与横竖屏保存操作。');
} finally { if (browser) await browser.close(); await server.stop(); }
