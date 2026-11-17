"use client";

import { Children, isValidElement, useState, type ComponentProps, type ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@shpyrd/ui/components/select";

type Option = { value?: string | number; disabled?: boolean; children?: ReactNode };
type Props = Pick<ComponentProps<typeof SelectTrigger>, "id" | "className" | "aria-label" | "aria-labelledby" | "aria-describedby" | "aria-invalid"> & {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    children: ReactNode;
    required?: boolean;
    disabled?: boolean;
    name?: string;
};

// Keeps domain option lists separate from the shared select's presentation.
export function SelectControl({ value: controlledValue, defaultValue = "", onValueChange, children, required, disabled, name, className = "", ...triggerProps }: Props) {
    const [localValue, setLocalValue] = useState(defaultValue);
    const value = controlledValue ?? localValue;
    const update = (next:string) => {setLocalValue(next);onValueChange?.(next);};
    const options = Children.toArray(children).filter(isValidElement<Option>).map(child => child.props);
    const empty = options.find(option => String(option.value ?? "") === "");
    const allowEmpty = !!empty && !empty.disabled && !required;
    const emptyKey = "__zbucket_none__";
    return <Select value={value || (allowEmpty ? emptyKey : "")} onValueChange={next => update(next === emptyKey ? "" : next)} required={required} disabled={disabled} name={name}>
        <SelectTrigger className={`w-full min-w-0 ${className}`} {...triggerProps}><SelectValue placeholder={empty?.children ?? "Select an option"}/></SelectTrigger>
        <SelectContent position="popper" className="max-w-[calc(100vw-2rem)]">
            {options.filter(option => String(option.value ?? "") !== "" || allowEmpty).map(option => <SelectItem key={String(option.value || emptyKey)} value={String(option.value || emptyKey)} disabled={option.disabled}>{option.children}</SelectItem>)}
        </SelectContent>
    </Select>;
}
