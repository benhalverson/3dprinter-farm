# Store Slant File IDs for Print Files

Slant3D hosts confirmed print files, and this API stores the Slant File ID as the durable print-file reference instead of storing presigned `fileURL` values. Slant download URLs expire, so product reads hydrate the legacy `stl` response field with a fresh Slant URL when a Slant File ID is available, while existing rows without an ID remain legacy data instead of being guessed or backfilled.
