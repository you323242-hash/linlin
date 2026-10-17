// Shared shape only; authorization and money are always checked by the server.
export const providerIds = order => order.providers?.length ? order.providers.map(p=>p.id) : order.providerId ? [order.providerId] : [];
export const isProvider = (order,id) => providerIds(order).includes(id);
export const providerCount = order => order.providerCount || 1;
export const providerConfirmed = (order,group,id) => providerCount(order) === 1 ? !!group?.provider : !!group?.providers?.[id];
export const allProvidersConfirmed = (order,group) => providerCount(order) === 1 ? !!group?.provider : providerIds(order).length === 2 && providerIds(order).every(id=>group?.providers?.[id]);
export const lowKd = order => (order.providers?.length ? order.providers : order.provider ? [order.provider] : []).some(p=>p.kd<1);
