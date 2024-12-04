import { describe, expect, it } from 'vitest';
import { generateSkuNumber } from '../../src/utils/generateSkuNumber';

describe('Generate SKU number', () => {
	it('should generate a SKU number', () => {
		const productName = 'test product';
		const productName2 = 'F1 Chassis';
		const productName3 = 'White T-Shirt';
		const productName4 = ' a t4 a - 4 a # $';
		const blackColor = '#000000';
		const whiteColor = '#FFFFFF';

		const skuNumber = generateSkuNumber(productName, blackColor);
		const skuNumber2 = generateSkuNumber(productName2, blackColor);
		const skuNumber3 = generateSkuNumber(productName3, whiteColor);
		const skuNumber4 = generateSkuNumber(productName4, whiteColor);
		expect(skuNumber).toEqual('TESTPROD-00000');
		expect(skuNumber2).toEqual('F1CHASSI-00000');
		expect(skuNumber3).toEqual('WHITET-S-FFFFF');
		expect(skuNumber4).toEqual('AT4A-4A#-FFFFF');
		expect(skuNumber).not.toEqual('TESTPROD-00001');
	});

	it('should handle empty product name', () => {
		const productName = '';
		const blackColor = '#000000';
		expect(() => generateSkuNumber(productName, blackColor)).toThrowError('Product name cannot be empty');
	});

	it('should handle empty product color', () => {
		const productName = 'test product';
		const blackColor = '';
		expect(() => generateSkuNumber(productName, blackColor)).toThrowError('Color cannot be empty');
	});


});
