# 3D Printer Web API

3D Printer Web API owns catalog, checkout, and fulfillment integration language for the print-farm storefront.

## Language

**Catalog Item**:
A sellable product record prepared for printing, with storefront copy, imagery, material selection, color, price, and print file metadata.
_Avoid_: Product card, listing

**Print File**:
The STL asset associated with a catalog item and confirmed for downstream printing.
_Avoid_: Model URL, raw STL link

**Slant File ID**:
The durable Slant3D identifier for a confirmed print file, used when estimating, ordering, and refreshing temporary download links.
_Avoid_: STL URL, fileURL, presigned URL
