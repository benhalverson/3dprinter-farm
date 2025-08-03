/**
 * Normalizes a string by replacing spaces with dashes and converting it to lowercase.
 * @param input The string to normalize.
 * @returns The normalized string.
 */
export const dashFilename = (input: string) => {
  const dot = input.lastIndexOf('.');
  const name = dot === -1 ? input : input.slice(0, dot);
  const ext  = dot === -1 ? ''       : input.slice(dot);   // includes "."

  const safe = name
    .trim()
    .replace(/\s+/g, '-')            // spaces → dash
    .replace(/_+/g, '-')             // underscores → dash
    .replace(/[^a-zA-Z0-9-]+/g, '-') // any other run → dash
    .replace(/-+/g, '-')             // collapse dashes
    .replace(/^-|-$/g, '')           // trim leading / trailing dash
    .toLowerCase();

  return safe + ext.toLowerCase();
};
