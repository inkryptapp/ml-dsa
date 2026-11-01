;; A saturating float-to-int conversion.
(module (func (param f32) (result i32) local.get 0 i32.trunc_sat_f32_s))
