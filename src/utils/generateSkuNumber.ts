/**
 * Generate a unique SKU number using timestamp and random suffix
 * Format: PREFIX-TIMESTAMP-RANDOM
 * Example: PROD-1702123456-A3B9
 * 
 * @param productName - Optional product name for prefix (defaults to 'PROD')
 * @returns A unique SKU number
 */
export const generateSkuNumber = (productName?: string) => {
  // Create prefix from product name or use default
  let prefix = 'PROD';
  if (productName && productName.trim()) {
    prefix = productName
      .replace(/[^a-zA-Z0-9]/g, '') // Remove special chars
      .slice(0, 4)
      .toUpperCase()
      .padEnd(4, 'X'); // Ensure 4 chars
  }
  
  // Use timestamp for uniqueness (last 10 digits of epoch)
  const timestamp = Date.now().toString().slice(-10);
  
  // Add random alphanumeric suffix for extra uniqueness
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const randomSuffix = Array.from({ length: 4 }, () => 
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join('');

  return `${prefix}-${timestamp}-${randomSuffix}`;
};
