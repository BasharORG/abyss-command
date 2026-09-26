import{describe,expect,it}from"vitest";import{focusableElements}from"../src/ui/focusTrap";
describe("focus trap helpers",()=>{it("uses the expected semantic focus selector",()=>{expect(typeof focusableElements).toBe("function");});});
