export const generateSkuNumber = (productName: string, color: string, ) => {
	const productCode = productName.slice(0, 8).toUpperCase();
	const colorCode = color.slice(0, 5).toUpperCase();

	return `${productCode}-${colorCode}`;
};
