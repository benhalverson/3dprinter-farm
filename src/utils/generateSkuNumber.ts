/**
 * Generate a SKU number based on the product name and color
 * @param productName - The name of the product
 * @param color - The color of the product
 * @returns Then generated SKU number
 */
export const generateSkuNumber = (productName: string, color: string) => {
  if (!productName.trim()) {
    throw new Error('Product name cannot be empty');
  }

  if (!color.trim()) {
    throw new Error('Color cannot be empty');
  }

  const productCode = productName.replace(/\s+/g, '').slice(0, 8).toUpperCase();
  const colorCode = color.replace('#', '').substring(0, 5).toUpperCase();

  return `${productCode}-${colorCode}`;
};
