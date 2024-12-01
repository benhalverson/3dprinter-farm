export const generateOrderNumber = () => {
	const datePrefix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 10);
	const randomNumber = Math.floor(100000 + Math.random() * 900000);
	return `${datePrefix}-${randomNumber}`;
};
