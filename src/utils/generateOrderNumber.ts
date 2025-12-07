export const generateOrderNumber = () => {
  const date = new Date();
  const datePrefix = date.toISOString().slice(0, 10).replace(/-/g, ''); // 'YYYYMMDD'
  const randomNumber = Math.floor(100000 + Math.random() * 900000); // 6 digits
  return `${datePrefix}-${randomNumber}`;
};
