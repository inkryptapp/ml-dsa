;; A call_indirect whose table index 0 takes two bytes, 0x80 0x00.
(module binary
  "\00asm\01\00\00\00"
  "\01\04\01\60\00\00"
  "\03\02\01\00"
  "\04\04\01\70\00\01"
  "\0a\0a\01\08\00\41\00\11\00\80\00\0b")
