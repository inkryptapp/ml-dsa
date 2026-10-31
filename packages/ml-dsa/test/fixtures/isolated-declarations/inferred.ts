// This export has no type annotation, so `tsc` rejects it with TS9013 under
// `isolatedDeclarations`. The typecheck test expects that error.

export const double = (value: number) => value * 2;
