import * as fg from "fast-glob";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as prettier from "prettier";
import * as R from "remeda";
import * as tsm from "ts-morph";
import {
  Decorator,
  MethodDeclaration,
  Node,
  Project,
  SyntaxKind,
  Type,
  TypeFlags,
} from "ts-morph";

/** Extracts message and event handlers and their pattern values and payload and return types and generates a convenient typed microservices client
 * Assumtions made:
 * - each service contains a main module with the same name as the dir in apps and module includes all controllers
 * - controllers are in files named (.*\.)?controller.ts
 * - message handler names are unique in each service and will be used as method name in client proxy
 * - message handler names should not start with "emit"
 * - name of message handlers where return value is an observable with possibly more than one value returned, should have a dollar sign ("$") at the end. this will be used to determine wether the corresponding client method will return an observable or promise.
 * - event patterns should be strings in the format "<service name in kebabcase>.<event name>". a corresponding method named "emit<event name in PacalCase>"" will be created in client proxy
 * - pattern values should either be a constant inline expression or have a type that contains a single possible value
 */

const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();

type MethodInfo = {
  controllerPath: string;
  className: string;
  methodName: string;
  pattern: string;
  paramIndex: number;
  serviceName: string;
  method: MethodDeclaration;
  isEventHandler: boolean;
  eventName?: string;
};

let errorFlag = false;

function getLineAndCol(node: Node) {
  const sourceFile = node.getSourceFile();
  const pos = node.getStart();
  const { line, column } = sourceFile.getLineAndColumnAtPos(pos);
  return `${line}:${column}`;
}

function valueFromType(type: Type) {
  const value = type.getLiteralValue();
  if (R.isDefined(value)) return value;

  if (
    type.isTuple() &&
    !(type.compilerType.combinedFlags & tsm.ts.ElementFlags.Variable)
  ) {
    return type.getTupleElements().map(valueFromType);
  }

  if (!type.isObject()) {
    throw new Error(`Can't extract value from type`);
  }

  return R.pullObject(
    type.getProperties(),
    (prop) => prop.getEscapedName(),
    (prop) => valueFromType(prop.getValueDeclaration().getType())
  );
}

const isDecoratorOneOf =
  (...names: [name: string] | [names: string[]] | string[]) =>
  (d: Decorator) => {
    const text = d
      .getExpressionIfKind(SyntaxKind.CallExpression)
      ?.getExpressionIfKind(SyntaxKind.Identifier)
      ?.getText();
    return names.flat().includes(text);
  };

const methodsByModule: Record<string, MethodInfo[]> = {};

async function main() {
  console.log("Initializing type checker...");
  const mainModulePaths = (await fg.async("apps/*/src/*.module.ts")).filter(
    (p) => /apps\/([^/]+)\/src\/\1.module.ts$/.test(p)
  );

  const tsConfig = await import(`${workspaceRoot}/tsconfig.json`);

  const compilerOptions = R.omit(tsConfig.compilerOptions, [
    "module",
    "moduleResolution",
    "target",
  ]);
  const project = new Project({ compilerOptions });
  project.addSourceFilesAtPaths(mainModulePaths);
  project.addSourceFileAtPath("libs/proxies/src/client.service.ts");
  project.resolveSourceFileDependencies();
  const checker = project.getTypeChecker();

  console.log("Extracting types for TCP Proxy from controllers...");

  for (const modulePath of mainModulePaths) {
    const controllerPaths = await fg.async(
      path.dirname(modulePath) + "/**/?(*.)controller.ts"
    );
    const basename = path.basename(modulePath, ".module.ts");
    const serviceName = R.capitalize(R.toCamelCase(basename));
    const serviceNameKebab = R.toKebabCase(serviceName);
    const eventPatternRe = new RegExp(
      `^(['"\`])${serviceNameKebab}\\.(?<name>[\\w-]+)\\1$`
    );

    const methods: MethodInfo[] = controllerPaths
      .map((controllerPath) =>
        project
          .getSourceFile(controllerPath)
          .getChildrenOfKind(SyntaxKind.ClassDeclaration)
          .filter((node) =>
            node.getModifiers().some((n) => n.isKind(SyntaxKind.ExportKeyword))
          )
          .map((classNode) =>
            classNode
              .getChildrenOfKind(SyntaxKind.MethodDeclaration)
              .map((method) => {
                const decorators = method.getDecorators();
                const patternDecorator = decorators.find(
                  isDecoratorOneOf("MessagePattern", "EventPattern")
                );

                if (!patternDecorator) return;

                const decoratorCallExpr =
                  patternDecorator.getExpressionIfKindOrThrow(
                    SyntaxKind.CallExpression
                  );
                const decoratorMethodIdentifier =
                  decoratorCallExpr.getExpressionIfKindOrThrow(
                    SyntaxKind.Identifier
                  );
                const isEventHandler =
                  decoratorMethodIdentifier.getText() === "EventPattern";
                const methodName = method.getName();
                const [patternExpr] = decoratorCallExpr.getArguments();
                const patternExprType = checker.getTypeAtLocation(patternExpr);
                const controllerPath = method.getSourceFile().getFilePath();

                if (
                  isEventHandler &&
                  !(patternExprType.getFlags() & TypeFlags.StringLike)
                ) {
                  console.error(
                    `Pattern expression for event handlers should be recognizable as string: method "${methodName}" in "${controllerPath}:${getLineAndCol(
                      decoratorCallExpr.getArguments()[0]
                    )}".`
                  );
                  errorFlag = true;
                  return;
                }

                if (!isEventHandler && methodName.startsWith("emit")) {
                  console.error(
                    `Message handler name should not start with "emit": method "${methodName}" in "${controllerPath}:${getLineAndCol(
                      method.getNameNode()
                    )}".`
                  );
                  errorFlag = true;
                  return;
                }

                const isInlinePattern =
                  Node.isLiteralExpression(patternExpr) ||
                  Node.isObjectLiteralExpression(patternExpr) ||
                  Node.isArrayLiteralExpression(patternExpr);

                let pattern = "";
                try {
                  const throwsWhenEvaluated = "(null).5";
                  pattern = isInlinePattern
                    ? patternExpr.getText()
                    : JSON.stringify(valueFromType(patternExprType)) ||
                      throwsWhenEvaluated;

                  if (R.isEmpty(eval(`(${pattern})`)))
                    throw new Error(`Can't extract pattern value`);
                } catch {
                  console.error(
                    `Couldn't extract pattern expression for "${methodName}" in "${controllerPath}:${getLineAndCol(
                      decoratorCallExpr.getArguments()[0]
                    )}".
                        Try using 'as const' in definition or simple literal expression`
                  );
                  errorFlag = true;
                  return;
                }

                if (isEventHandler && !eventPatternRe.test(pattern)) {
                  console.error(
                    `Event handler pattern should be in the format "<service_name_in_kebabcase>.<event_name>": ${pattern} in "${controllerPath}:${getLineAndCol(
                      decoratorCallExpr.getArguments()[0]
                    )}".`
                  );
                  errorFlag = true;
                  return;
                }

                const parameters = method.getParameters();
                const decoratedParameterIndex = parameters.findIndex((p) =>
                  p.getDecorators().some(isDecoratorOneOf("Payload", "Body"))
                );

                const paramIndex =
                  parameters.length > 0 && decoratedParameterIndex === -1
                    ? 0
                    : decoratedParameterIndex;

                const eventName = isEventHandler
                  ? R.toCamelCase(pattern.match(eventPatternRe)?.groups.name)
                  : undefined;

                return {
                  controllerPath,
                  className: classNode.getName(),
                  methodName,
                  pattern,
                  paramIndex,
                  serviceName,
                  isEventHandler,
                  eventName,
                  method,
                };
              })
          )
      )
      .flat(2)
      .filter(R.isDefined);

    if (methods.length == 0) continue;

    const duplicateControllerNames = R.pipe(
      methods,
      R.groupBy(R.prop("className")),
      R.mapValues(R.groupBy(R.prop("controllerPath"))),
      R.pickBy((group) => Object.keys(group).length > 1),
      R.mapValues((group) => R.values(group).flat())
    );

    // Aliased import of duplicate class names
    for (const info of R.values(duplicateControllerNames).flat()) {
      info.className = `${info.className} as ${serviceName}${info.className}`;
    }

    const controllerClassImports = R.pipe(
      methods,
      R.groupBy(R.prop("controllerPath")),
      R.mapValues((msgInfos) =>
        R.pipe(msgInfos, R.map(R.prop("className")), R.unique())
      ),
      R.entries(),
      R.map(
        ([filePath, classes]) =>
          `import type {${classes}} from '${path
            .relative(workspaceRoot, filePath)
            .replace(/\.ts$/, "")}';`
        // `// nx-ignore-next-line\nimport type {${classes}} from '${path.replace(/\.ts$/, '')}';`,
      ),
      R.join("\n")
    );

    // Replace with alias after generating import statments and before interfaces
    for (const [originalName, group] of R.entries(duplicateControllerNames)) {
      for (const info of group) {
        info.className = `${serviceName}${originalName}`;
      }
    }

    const duplicateGroups = R.pipe(
      methods,
      R.groupBy(R.prop("methodName")),
      R.values(),
      R.filter((group) => group.length > 1)
    );

    for (const duplicateGroup of duplicateGroups) {
      const sep = "\n    ";
      const errMsgs = duplicateGroup.map(
        (info) =>
          `"${info.methodName}" in "${info.controllerPath}:${getLineAndCol(
            info.method
          )}"`
      );
      console.error(
        `The following methods in service "${serviceName}" are not named uniquely. Please rename them:${sep}${errMsgs.join(
          sep
        )}\n\n`
      );
      errorFlag = true;
    }

    const [events, msgs] = R.partition(methods, (m) => m.isEventHandler);
    const fileContent = `
    import type { Observable } from 'rxjs';
    import type { ProxyMethod, Options } from 'libs/proxies/client.service';
    ${controllerClassImports}

    export interface ${serviceName}Proxy {
      ${msgs.map(generateMsgProxyMethods).join("    \n")}
      ${generateEventProxyMethods(events).join("    \n")}
    }`;

    const outFile = path.join(
      path.dirname(modulePath),
      `${serviceNameKebab}.proxy.generated.ts`
    );

    const prettierConfig = await prettier.resolveConfig(outFile);

    const formatted = await prettier.format(fileContent, {
      ...prettierConfig,
      parser: "typescript",
    });
    await fs.writeFile(outFile, formatted);
    methodsByModule[modulePath] = methods;
  }

  function generateMsgProxyMethods(info: MethodInfo) {
    // const methodType = `${info.className}['${info.methodName}']`;
    // const params =
    //   info.paramIndex === -1
    //     ? ''
    //     : `data: Parameters<${methodType}>[${info.paramIndex}]`;
    // return `${info.methodName}(${params}${params ? ', ' : ''}options?: Options): ReturnType<${methodType}>;`;
    return `${info.methodName}: ProxyMethod<${info.className}, '${info.methodName}', ${info.paramIndex}>;`;
  }

  function generateEventProxyMethods(eventInfos: MethodInfo[]) {
    return R.pipe(
      eventInfos,
      R.groupBy(R.prop("eventName")),
      R.entries(),
      R.map(([eventName, group]) => {
        // Intersection type of all payload types used in handlers for this event
        const payloadType = group
          .filter((m) => m.paramIndex !== -1)
          .map(
            (m) =>
              `Parameters<${m.className}['${m.methodName}']>[${m.paramIndex}]`
          )
          .join(" & ");
        const methodName = `emit${R.capitalize(eventName)}`;
        const args = payloadType ? `payload: ${payloadType}, ` : "";
        return `${methodName}(${args}options?: Options): Observable<unknown>;`;
      })
    );
  }

  // function generateModuleInterface(infos: MethodInfo[]) {
  //   const [eventInfos, msgInfos] = R.partition(infos, (m) => m.isEventHandler);
  //   return `
  //   export interface ${R.first(msgInfos).serviceName}Methods {
  //     ${msgInfos.map(generateMsgProxyMethods).join('    \n')}
  //     ${generateEventProxyMethods(eventInfos).join('    \n')}
  //   }`;
  // }

  const duplicateGroups = R.pipe(
    mainModulePaths,
    R.groupBy((p) => path.basename(p)),
    R.values(),
    R.filter((group) => group.length > 1)
  );

  for (const duplicateGroup of duplicateGroups) {
    const sep = "\n    ";
    console.error(
      `The following services are not named uniquely. Please rename them:${sep}${duplicateGroup.join(
        sep
      )}\n\n`
    );
    errorFlag = true;
  }

  // const byModule = R.groupBy(results, R.prop('modulePath'));

  // for (const moduleMethods of Object.values(allMethodsByModule)) {
  //   const duplicateGroups = R.pipe(
  //     moduleMethods,
  //     R.groupBy(R.prop('methodName')),
  //     R.values(),
  //     R.filter((group) => group.length > 1),
  //   );

  //   for (const duplicateGroup of duplicateGroups) {
  //     const sep = '\n    ';
  //     const { serviceName } = R.first(duplicateGroup);
  //     const methods = duplicateGroup.map(
  //       (info) =>
  //         `"${info.methodName}" in "${info.controllerPath}:${getLineAndCol(info.method)}"`,
  //     );
  //     console.error(
  //       `The following methods in service "${serviceName}" are not named uniquely. Please rename them:${sep}${methods.join(sep)}\n\n`,
  //     );
  //     errorFlag = true;
  //   }
  // }

  // const interfaces = R.pipe(
  //   byModule,
  //   R.mapValues(generateModuleInterface),
  //   R.values(),
  //   R.join('\n'),
  // );

  //   const proxyInterface = `
  // export interface ClientProxy {
  //     ${serviceNames.map((name) => `${R.uncapitalize(name)}: ${name}Methods;`).join('    \n')}
  // }`;

  const patternMap = R.pipe(
    methodsByModule,
    R.mapKeys((_, group) => R.uncapitalize(R.first(group).serviceName)),
    R.mapValues(
      R.map(
        (info) =>
          `${
            info.isEventHandler
              ? "emit" + R.capitalize(info.eventName)
              : info.methodName
          }: [(${info.pattern}), ${info.paramIndex != -1}]`
      )
    ),
    R.entries(),
    R.map(([name, patterns]) => `${name}: {${patterns}}`),
    R.join(",")
  );

  const outDir = path.join(__dirname, "generated");

  // const interfacesFile = path.join(outDir, 'services.interface.ts');
  const patternsFile = path.join(outDir, "patterns.ts");

  // const rxjsImport = `import type { Observable } from 'rxjs';`;
  // const optionTypeImport = `import type { ProxyMethod, Options } from '../client.service'`;
  // const interfacesFileContent = `${rxjsImport}\n${controllerClassImports}\n${optionTypeImport}\n\n${interfaces}\n\n${proxyInterface}`;
  // const patternsFileContent = `export const patternMap = {${patternMap}} as const;\n`;

  console.log("Formatting with Prettier and writing files...");

  await fs.mkdir(outDir, { recursive: true });

  // const p1 = prettier
  //   .format(interfacesFileContent, { parser: 'typescript' })
  //   .then((content) => fs.writeFile(interfacesFile, content));

  // const p2 = prettier
  //   .format(patternsFileContent, { parser: 'typescript' })
  //   .then((content) => fs.writeFile(patternsFile, content));

  // await Promise.all([p1, p2]);

  const prettierConfig = await prettier.resolveConfig(patternsFile);

  const formatted = await prettier.format(
    `
    import type { Observable } from 'rxjs';
    export const patternMap = {${patternMap}} as const;
    `,
    { ...prettierConfig, parser: "typescript" }
  );
  await fs.writeFile(patternsFile, formatted);
  console.log("done");
}

void main()
  .then(() => {
    if (errorFlag) {
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
