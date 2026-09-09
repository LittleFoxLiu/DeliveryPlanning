import { esc, money } from '../ui';
import type { ProductDto } from '../types';

/** productId -> quantity */
export type Cart = Record<string, number>;

export function cartLines(cart: Cart, catalog: ProductDto[]): { p: ProductDto; qty: number; lineCents: number }[] {
  return catalog
    .filter((p) => (cart[p.id] || 0) > 0)
    .map((p) => ({ p, qty: cart[p.id], lineCents: cart[p.id] * p.priceCents }));
}

export function cartTotalCents(cart: Cart, catalog: ProductDto[]): number {
  return cartLines(cart, catalog).reduce((n, l) => n + l.lineCents, 0);
}

export function cartCount(cart: Cart): number {
  return Object.values(cart).reduce((n, q) => n + (q > 0 ? q : 0), 0);
}

/** [{ productId, qty }] payload for POST /…/orders */
export function cartItems(cart: Cart): { productId: string; qty: number }[] {
  return Object.entries(cart).filter(([, q]) => q > 0).map(([productId, qty]) => ({ productId, qty }));
}

export function productGrid(catalog: ProductDto[], cart: Cart): string {
  if (!catalog.length) return '<p class="muted">This store hasn\'t listed any products yet.</p>';
  return `<div class="shop-grid">${catalog.map((p) => {
    const qty = cart[p.id] || 0;
    return `<div class="shop-card">
      <h3>${esc(p.name)}</h3>
      <span class="price">${money(p.priceCents)}</span>
      <span class="desc">${esc(p.description || '')}</span>
      <span class="muted" style="font-size:11px">${esc(p.packageSize)} package</span>
      <div class="row">
        <span class="stepper">
          <button type="button" data-cart-dec="${esc(p.id)}"${qty ? '' : ' disabled'}>–</button>
          <span>${qty}</span>
          <button type="button" data-cart-inc="${esc(p.id)}">+</button>
        </span>
      </div>
    </div>`;
  }).join('')}</div>`;
}

export function cartSummary(catalog: ProductDto[], cart: Cart): string {
  const lines = cartLines(cart, catalog);
  if (!lines.length) return '<p class="cart-empty">No items yet — add products above.</p>';
  return `${lines.map((l) => `<div class="cart-line"><span>${esc(l.p.name)} × ${l.qty}</span><span>${money(l.lineCents)}</span></div>`).join('')}
    <div class="cart-total"><span>Total</span><span>${money(cartTotalCents(cart, catalog))}</span></div>`;
}

/** Wire +/- steppers. `onchange` is called after the cart mutates. */
export function wireCart(el: HTMLElement, cart: Cart, onchange: () => void): void {
  el.querySelectorAll<HTMLButtonElement>('[data-cart-inc]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.cartInc!;
    cart[id] = Math.min(99, (cart[id] || 0) + 1);
    onchange();
  }));
  el.querySelectorAll<HTMLButtonElement>('[data-cart-dec]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.cartDec!;
    cart[id] = Math.max(0, (cart[id] || 0) - 1);
    if (!cart[id]) delete cart[id];
    onchange();
  }));
}
