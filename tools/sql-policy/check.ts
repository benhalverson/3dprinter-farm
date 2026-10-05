import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  '.wrangler',
  'coverage',
  '.generated',
]);
const sourceExtension = /\.[cm]?[jt]sx?$/;
const declarationExtension = /\.d\.[cm]?ts$/;
const rawMembers = new Set([
  'prepare',
  'exec',
  'execute',
  'executeMultiple',
  'query',
  'run',
  'all',
  'get',
  'values',
  'batch',
  'pragma',
]);
const rawConstructors = new Set(['sql', 'SQL', 'StringChunk']);

export function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (ignoredDirectories.has(entry.name)) return [];
    const file = path.join(root, entry.name);
    // Do not follow symlinks outside this checkout.
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() ? [file] : [];
  });
}

export function checkFiles(root: string, migrationDirectory: string): string[] {
  const files = sourceFiles(root);
  const migrationRoot = path.resolve(root, migrationDirectory);
  const issues = files
    .filter(
      file =>
        file.endsWith('.sql') &&
        !file.startsWith(`${migrationRoot}${path.sep}`),
    )
    .map(
      file =>
        `${path.relative(root, file)}: SQL files belong in the configured Drizzle migration directory.`,
    );
  const authored = files.filter(
    file =>
      sourceExtension.test(file) &&
      !declarationExtension.test(file) &&
      // Drizzle introspection output, not an authored schema source.
      !['schema.ts', 'relations.ts'].some(
        name => file === path.join(migrationRoot, name),
      ),
  );
  const configFile = ts.readConfigFile(
    path.join(root, 'tsconfig.json'),
    ts.sys.readFile,
  );
  if (configFile.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
    );
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  const program = ts.createProgram(authored, {
    ...config.options,
    allowJs: true,
    noEmit: true,
  });
  return issues.concat(inspectProgram(program, new Set(authored)));
}

export function inspectProgram(
  program: ts.Program,
  authored: Set<string>,
): string[] {
  const checker = program.getTypeChecker();
  const issues: string[] = [];

  function symbolAt(node: ts.Node) {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  }

  function fromDrizzle(symbol: ts.Symbol | undefined) {
    return symbol?.declarations?.some(declaration =>
      /[/\\]drizzle-orm[/\\]/.test(declaration.getSourceFile().fileName),
    );
  }

  function rawApi(symbol: ts.Symbol | undefined) {
    return (
      fromDrizzle(symbol) &&
      rawConstructors.has(symbol?.name ?? '') &&
      symbol?.declarations?.some(
        node =>
          ts.isFunctionDeclaration(node) ||
          ts.isModuleDeclaration(node) ||
          ts.isClassDeclaration(node),
      )
    );
  }

  function databaseMember(node: ts.Node, name: string) {
    if (!rawMembers.has(name)) return false;
    const symbol = symbolAt(node);
    return symbol?.declarations?.some(declaration => {
      const file = declaration.getSourceFile().fileName;
      // Builder .run()/.all() are legitimate; base/session raw methods are not.
      if (/drizzle-orm[/\\]/.test(file)) {
        return (
          name !== 'batch' &&
          name !== 'query' &&
          !/query-builders[/\\]/.test(file) &&
          /[/\\](db|session)\.d\.[cm]?ts$/.test(file)
        );
      }
      if (
        /(@libsql|better-sqlite3|[/\\]sqlite3[/\\]|[/\\]pg[/\\]|[/\\]mysql2[/\\])/.test(
          file,
        )
      )
        return true;
      let parent: ts.Node | undefined = declaration.parent;
      while (parent) {
        if (
          (ts.isInterfaceDeclaration(parent) ||
            ts.isClassDeclaration(parent)) &&
          /^(D1Database|D1DatabaseSession|D1PreparedStatement|SqlStorage|DatabaseSync|StatementSync)$/.test(
            parent.name?.text ?? '',
          )
        )
          return true;
        parent = parent.parent;
      }
      return false;
    });
  }

  for (const source of program.getSourceFiles()) {
    if (!authored.has(source.fileName)) continue;
    const report = (node: ts.Node, message: string) => {
      const location = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      issues.push(
        `${source.fileName}:${location.line + 1}:${location.character + 1}: ${message}`,
      );
    };
    const visit = (node: ts.Node) => {
      // Import aliases cannot hide the underlying API. Type-only SQL imports are valid.
      if (
        ts.isImportSpecifier(node) &&
        !node.isTypeOnly &&
        !node.parent.parent.isTypeOnly &&
        (node.propertyName ?? node.name).text === 'sql' &&
        fromDrizzle(symbolAt(node.name))
      )
        report(
          node,
          'Use Drizzle builders and application defaults, not raw SQL constructors.',
        );
      if (
        ts.isNewExpression(node) &&
        (rawApi(symbolAt(node.expression)) ||
          rawApi(checker.getTypeAtLocation(node.expression).symbol))
      ) {
        report(node, 'Raw SQL constructors are forbidden.');
      }
      if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        const member = ts.isPropertyAccessExpression(node)
          ? node.name
          : node.argumentExpression;
        const name =
          ts.isIdentifier(member) || ts.isStringLiteralLike(member)
            ? member.text
            : '';
        if (name === 'sql' && rawApi(symbolAt(member))) {
          report(node, 'Raw Drizzle SQL construction is forbidden.');
        } else if (name === 'defaultNow' && fromDrizzle(symbolAt(member))) {
          report(node, 'Use $defaultFn for application timestamp defaults.');
        } else if (databaseMember(member, name)) {
          report(
            node,
            'Direct database execution is forbidden; use Drizzle query builders.',
          );
        }
      }
      // Destructuring an API is also an escape hatch, even if called under another name.
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const member = node.propertyName ?? node.name;
        const name =
          ts.isIdentifier(member) || ts.isStringLiteralLike(member)
            ? member.text
            : '';
        if (
          (name === 'sql' && rawApi(symbolAt(member))) ||
          databaseMember(member, name)
        ) {
          report(node, 'Aliased raw database APIs are forbidden.');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return issues;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const root = process.cwd();
  // Read configuration as syntax, without executing application code or loading credentials.
  const config = ts.createSourceFile(
    'drizzle.config.ts',
    readFileSync('drizzle.config.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let migrationDirectory: string | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(config) === 'out' &&
      ts.isStringLiteral(node.initializer)
    )
      migrationDirectory = node.initializer.text;
    ts.forEachChild(node, visit);
  };
  visit(config);
  if (!migrationDirectory)
    throw new Error('Expected a literal Drizzle migration out directory.');
  const issues = checkFiles(root, migrationDirectory);
  if (issues.length) {
    console.error(issues.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      'SQL policy passed (migration location checked; generation provenance requires workflow evidence).',
    );
}
