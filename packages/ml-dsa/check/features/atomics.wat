;; A shared memory and an atomic load.
(module (memory 1 1 shared) (func (result i32) i32.const 0 i32.atomic.load))
