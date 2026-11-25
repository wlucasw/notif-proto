// Routing rules: which event triggers which message, on which channels.
// In production, this file would become configuration (database or versioned file)
// editable without redeployment.

export const CATEGORY = {
  TRANSACTIONAL: 'transactional', // order-related: no marketing consent required
  MARKETING: 'marketing',         // promotions: explicit opt-in required (GDPR / ePrivacy)
};

export const RULES = {
  'order.placed': {
    category: CATEGORY.TRANSACTIONAL,
    channels: ['email', 'push'],
    priority: 'high',
  },
  'order.shipped': {
    category: CATEGORY.TRANSACTIONAL,
    channels: ['email', 'push', 'sms'],
    priority: 'high',
  },
  'order.delivered': {
    category: CATEGORY.TRANSACTIONAL,
    channels: ['push', 'sms'],
    priority: 'high',
  },
  'promotion.started': {
    category: CATEGORY.MARKETING,
    channels: ['push', 'email'],
    priority: 'low',
    // Anti-spam: at most one promo per user within the window
    throttle: { maxPerUser: 1, windowMs: 24 * 60 * 60 * 1000 },
    // A product is "recently viewed" if it was viewed within this window
    recentViewWindowMs: 7 * 24 * 60 * 60 * 1000,
  },
};

// Required payload fields per event type. 'number' enforces the type;
// 'any' just requires a non-empty value. Also defines the supported event types.
export const REQUIRED_FIELDS = {
  'order.placed': { orderId: 'any', userId: 'any' },
  'order.shipped': { orderId: 'any', userId: 'any' },
  'order.delivered': { orderId: 'any', userId: 'any' },
  'product.viewed': { userId: 'any', productId: 'any' },
  'promotion.started': { productId: 'any', productName: 'any', discountPercent: 'number' },
};

export const TEMPLATES = {
  'order.placed': ({ orderId, total }) => ({
    subject: `Order ${orderId} confirmed`,
    body: `Thank you! Your order ${orderId}${total ? ` (€${total})` : ''} has been placed.`,
  }),
  'order.shipped': ({ orderId, carrier, trackingNumber }) => ({
    subject: `Order ${orderId} shipped`,
    body: `Your order ${orderId} is on its way${carrier ? ` with ${carrier}` : ''}${trackingNumber ? ` (tracking: ${trackingNumber})` : ''}.`,
  }),
  'order.delivered': ({ orderId }) => ({
    subject: `Order ${orderId} delivered`,
    body: `Your order ${orderId} has been delivered. Enjoy!`,
  }),
  'promotion.started': ({ productName, discountPercent }) => ({
    subject: `${discountPercent}% off ${productName}`,
    body: `${productName}, which you recently viewed, is now ${discountPercent}% off.`,
  }),
};
