import {
  Observable,
  ObservedValueOf,
  lastValueFrom,
  switchMap,
  timeout,
  defer,
  tap,
  retry,
  first,
} from "rxjs";
import { patternMap } from "./generated/patterns";
import { ClientProxyFactory, type ClientOptions } from "@nestjs/microservices";
import { Logger } from "@nestjs/common";

export const SERVICE_TIMEOUT = 5000;

export interface Options {
  timeout?: number;
}

type WrapReturn<R, MethodName> = MethodName extends `${string}$`
  ? Observable<ObservedValueOf<R>>
  : R extends Promise<any>
  ? R
  : Promise<R>;

type Helper1<
  Args extends any[],
  Ret,
  MethodName,
  ArgIndex extends number
> = ArgIndex extends -1
  ? (options?: Options) => WrapReturn<Ret, MethodName>
  : (payload: Args[ArgIndex], options?: Options) => WrapReturn<Ret, MethodName>;

/* Extract overloaded parameters and return types of functions with up to three signatures */
type Overloads<Function, N, I extends number> = Function extends {
  (..._: infer A1): infer R1;
  (..._: infer A2): infer R2;
  (..._: infer A3): infer R3;
}
  ? Helper1<A1, R1, N, I> & Helper1<A2, R2, N, I> & Helper1<A3, R3, N, I>
  : Function extends { (..._: infer A1): infer R1; (..._: infer A2): infer R2 }
  ? Helper1<A1, R1, N, I> & Helper1<A2, R2, N, I>
  : Function extends { (..._: infer A1): infer R1 }
  ? Helper1<A1, R1, N, I>
  : never;

export type ProxyMethod<
  Controller,
  MethodName extends keyof Controller,
  ArgIndex extends number
> = Overloads<Controller[MethodName], MethodName, ArgIndex>;

type ServiceName = string & keyof typeof patternMap;

export function createClientProxy<
  Service extends { token: Token },
  Token extends Symbol
>(
  serviceName: ServiceName,
  token: Token,
  clientOptions: ClientOptions
): Service {
  const logger = new Logger(`ClientProxy(${String(token)})`);
  const client = ClientProxyFactory.create(clientOptions);
  let firstCall = true;

  const connect = () => {
    if (!firstCall) {
      return client.status.pipe(
        tap((s) => {
          if (s !== "connected") {
            throw new Error(`Client not connected to ${serviceName}`);
          }
        })
      );
    }
    firstCall = false;
    const attempt$ = defer(() => client.connect());
    const connection$ = attempt$.pipe(
      timeout(2000),
      tap({ error: (e) => logger.warn(e, serviceName) }),
      retry({ count: 5, delay: 3000 }),
      tap({
        error: (err) => {
          logger.error({
            error: err.message,
            message: `Max retries exceeded, unable to connect to ${serviceName}`,
          });
        },
        next: () => logger.debug(`${serviceName} connection established`),
      })
    );
    return connection$;
  };

  const proxy = new Proxy(
    {},
    {
      get(target: any, methodName: string) {
        if (methodName in target) return target[methodName];

        const [pattern, hasPayload] = patternMap[serviceName];
        const isEmitMethod = methodName.startsWith("emit");
        const isObservable = isEmitMethod || methodName.endsWith("$");
        const m = client[isEmitMethod ? "emit" : "send"].bind(client);

        target[methodName] = (arg1: unknown, arg2: unknown) => {
          const payload = hasPayload ? arg1 : {};
          const options = (hasPayload ? arg2 : arg1) as Options | undefined;
          const ms = options?.timeout ?? SERVICE_TIMEOUT;
          const ob$ = connect().pipe(
            first(),
            switchMap(() => m(pattern, payload).pipe(timeout(ms)))
          );
          return isObservable ? ob$ : lastValueFrom(ob$);
        };

        return target[methodName];
      },
    }
  );

  return proxy;
}
