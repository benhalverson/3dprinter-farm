// Generate a unique order number with a UUID-like format
import crypto from 'crypto';
export const generateOrderNumber = (): string => {
	return `ORD-${crypto.randomUUID().toUpperCase()[0]}`;
};
