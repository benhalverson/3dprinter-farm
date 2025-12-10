export const calculateMarkupPrice = (
  basePrice: number,
  markupPercentage: number,
): number => {
  if (markupPercentage <= 0) {
    throw new Error('Invalid markup percentage');
  }
  const markUpPrice = basePrice + basePrice * (markupPercentage / 100);
  return parseFloat(markUpPrice.toFixed(2));
};
