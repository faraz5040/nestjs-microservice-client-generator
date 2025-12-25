# nestjs-microservice-client-generator
Extracts types from message and event handlers in NestJS controllers and generates a typed client for NestJS microservice communication

## Code Conventions

To use this library effectively, your NestJS microservice project must follow these conventions:

- **Module and Controller Structure**:
	- Each service should have a main module with the same name as its directory in `apps/`, and the module must include all controllers.
	- Controllers must be in files named `controller.ts` or `*.controller.ts`.

- **Message Handler Naming**:
	- Message handler method names must be unique within each service.
	- Message handler names **must not** start with `emit`.
	- If a message handler returns an Observable (i.e., may emit multiple values), its name **must end with a dollar sign (`$`)**. This determines whether the generated client method returns an Observable or a Promise.

- **Event Pattern Conventions**:
	- Event patterns must be strings in the format `<service-name-in-kebabcase>.<event-name>`.
	- For each event handler, a corresponding client method named `emit<EventNameInPascalCase>` will be generated.

- **Pattern Values**:
	- Pattern values must be either a constant inline expression or have a type that contains a single possible value.

- **Other Requirements**:
	- All message and event handler methods must use the appropriate NestJS decorators (`@MessagePattern`, `@EventPattern`).
	- For event handlers, the pattern expression must be recognizable as a string literal.
	- The generator expects that the main module and controller class names are unique within the service.

Failure to follow these conventions may result in errors or incomplete client generation.
