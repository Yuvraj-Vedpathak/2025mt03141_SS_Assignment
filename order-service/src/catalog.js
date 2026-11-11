// Read-only menu catalog used to price orders on the server side, so a price sent by the client is never trusted.
// In the full FoodExpress design this is a local replica of the Restaurant Service's menu,
// kept up to date from its MenuUpdated events. It is static here because only the
// Order and Payment services are implemented.
const RESTAURANTS = {
  'rest-001': {
    name: 'Spice Garden',
    city: 'Pune',
    items: {
      'item-101': { name: 'Paneer Butter Masala', price: 249, available: true },
      'item-102': { name: 'Butter Naan', price: 45, available: true },
      'item-103': { name: 'Chicken Biryani', price: 299, available: true },
      'item-104': { name: 'Gulab Jamun', price: 89, available: false },
    },
  },
  'rest-002': {
    name: 'Dragon Wok',
    city: 'Pune',
    items: {
      'item-201': { name: 'Veg Hakka Noodles', price: 189, available: true },
      'item-202': { name: 'Chilli Chicken', price: 259, available: true },
    },
  },
};

// Returns { restaurantName, items: [{menuItemId, name, unitPrice, quantity}] } or { errors: [...] }.
function priceItems(restaurantId, items) {
  const restaurant = RESTAURANTS[restaurantId];
  if (!restaurant) return { notFound: true };
  const errors = [];
  const priced = [];
  for (const line of items) {
    const quantity = Number(line && line.quantity);
    const menuItemId = line && line.menuItemId;
    if (!menuItemId || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      errors.push(`Each item needs a menuItemId and an integer quantity of 1-50 (got ${JSON.stringify(line)})`);
      continue;
    }
    const item = restaurant.items[menuItemId];
    if (!item) {
      errors.push(`Menu item ${menuItemId} does not belong to restaurant ${restaurantId}`);
    } else if (!item.available) {
      errors.push(`Menu item ${menuItemId} (${item.name}) is currently unavailable`);
    } else {
      priced.push({ menuItemId, name: item.name, unitPrice: item.price, quantity });
    }
  }
  return { restaurantName: restaurant.name, items: priced, errors };
}

function listMenu() {
  return Object.entries(RESTAURANTS).map(([id, r]) => ({
    id,
    name: r.name,
    city: r.city,
    items: Object.entries(r.items).map(([itemId, i]) => ({ id: itemId, ...i })),
  }));
}

module.exports = { priceItems, listMenu };
