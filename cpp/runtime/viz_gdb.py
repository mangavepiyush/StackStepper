import glob
import itertools
import json
import os
import re
import sys

import gdb

MAX_DEPTH = 4
MAX_CHILDREN = 24
MAX_BYTES = 128


def load_libstdcxx_printers():
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    bundled_glob = os.path.join(base_dir, "runtime", "mingw", "share", "gcc-*", "python").replace("\\", "/")
    candidates = sorted(glob.glob(bundled_glob), reverse=True) + sorted(glob.glob("C:/mingw64/share/gcc-*/python"), reverse=True)

    for candidate in candidates:
        if candidate not in sys.path:
            sys.path.insert(0, candidate)

        try:
            from libstdcxx.v6.printers import register_libstdcxx_printers

            register_libstdcxx_printers(None)
            return True
        except Exception:
            continue

    return False


LIBSTDCXX_PRINTERS_ENABLED = load_libstdcxx_printers()


def safe_string(value):
    try:
        return str(value)
    except Exception as error:
        return f"<unavailable: {error}>"


def safe_address(value):
    try:
        return getattr(value, "address", None)
    except Exception:
        return None


def format_address(address):
    if address is None:
        return None

    try:
        return hex(int(address))
    except Exception:
        try:
            return safe_string(address)
        except Exception:
            return None


def normalize_type_name(type_name):
    normalized = type_name.replace("class ", "").replace("struct ", "")
    normalized = normalized.replace("std::__cxx11::", "std::")
    normalized = re.sub(r"std::__\d+::", "std::", normalized)
    return normalized


def strip_quotes(text):
    if text and len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        return text[1:-1]
    return text


def parse_scalar(value):
    value_type = value.type.strip_typedefs()
    code = value_type.code

    try:
        if code == gdb.TYPE_CODE_BOOL:
            return bool(int(value))

        if is_char_type(value_type):
            codepoint = int(value) & 0xFF
            char_value = chr(codepoint)
            if char_value.isprintable():
                return repr(char_value)
            return f"\\x{codepoint:02x}"

        if code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_ENUM):
            return int(value)

        if code == gdb.TYPE_CODE_FLT:
            return float(value)
    except Exception:
        return safe_string(value)

    return safe_string(value)


def is_char_type(value_type):
    try:
        return value_type.strip_typedefs().name in ("char", "signed char", "unsigned char")
    except Exception:
        return False


def is_std_type(type_name):
    return normalize_type_name(type_name).startswith("std::")


def try_read_c_string(value):
    try:
        return value.string(errors="replace")
    except Exception:
        return None


def try_get_printer(value):
    try:
        return gdb.default_visualizer(value)
    except Exception:
        return None


def safe_printer_hint(printer):
    if not printer or not hasattr(printer, "display_hint"):
        return None

    try:
        return printer.display_hint()
    except Exception:
        return None


def safe_printer_summary(printer):
    if not printer or not hasattr(printer, "to_string"):
        return None

    try:
        return safe_string(printer.to_string())
    except Exception:
        return None


def infer_pretty_kind(type_name, hint):
    lower = normalize_type_name(type_name).lower()

    if "unordered_map" in lower:
        return "unordered_map"

    if "map<" in lower or "multimap" in lower or hint == "map":
        return "map"

    if "unordered_set" in lower:
        return "unordered_set"

    if "multiset" in lower or "set<" in lower:
        return "set"

    if "forward_list" in lower:
        return "forward_list"

    if "list<" in lower:
        return "list"

    if "deque" in lower:
        return "deque"

    if "priority_queue" in lower:
        return "priority_queue"

    if "queue" in lower:
        return "queue"

    if "stack" in lower:
        return "stack"

    if "vector" in lower:
        return "vector"

    if "array<" in lower or hint == "array":
        return "array"

    if "pair" in lower:
        return "pair"

    if "tuple" in lower:
        return "tuple"

    if "optional" in lower:
        return "optional"

    if "variant" in lower:
        return "variant"

    if "span" in lower:
        return "span"

    if "bitset" in lower:
        return "bitset"

    if "valarray" in lower:
        return "valarray"

    if hint == "string" or lower.startswith("std::basic_string<") or lower.startswith("std::string") or "string_view" in lower:
        return "string"

    if is_std_type(lower):
        return "container"

    return "object"


def collect_allocations():
    allocations = []

    try:
        count = int(gdb.parse_and_eval("__viz_allocation_count"))
    except Exception:
        return allocations

    inferior = gdb.selected_inferior()

    for index in range(count):
        try:
            record = gdb.parse_and_eval(f"__viz_allocations[{index}]")
            active = int(record["active"]) == 1
            size = int(record["size"])
            address = format_address(record["address"])

            allocation = {
                "index": index,
                "id": int(record["id"]),
                "address": address,
                "size": size,
                "active": active,
                "isArray": int(record["isArray"]) == 1,
                "bytes": "",
            }

            if active and address and size > 0:
                try:
                    memory = inferior.read_memory(int(record["address"]), min(size, MAX_BYTES))
                    allocation["bytes"] = bytes(memory).hex()
                except Exception:
                    allocation["bytes"] = ""

            allocations.append(allocation)
        except Exception:
            continue

    return allocations


def register_address_type(context, address, target_type):
    if not address:
        return

    bucket = context["address_types"].setdefault(address, [])
    target_name = normalize_type_name(safe_string(target_type))

    for existing in bucket:
        if normalize_type_name(safe_string(existing)) == target_name:
            return

    bucket.append(target_type)


def contiguous_element_count(allocation, element_type):
    try:
        element_size = int(element_type.sizeof)
    except Exception:
        return None

    if element_size <= 0:
        return None

    if allocation["size"] < element_size:
        return None

    if allocation["size"] % element_size != 0:
        return None

    count = allocation["size"] // element_size
    return count if count > 1 else None


def serialize_contiguous_array(element_type, address_int, count, path, seen, edges, context, depth):
    result = {
        "path": path,
        "type": normalize_type_name(safe_string(element_type)),
        "address": format_address(address_int),
        "display": f"{count} elements",
        "kind": "array",
        "length": count,
        "children": [],
    }

    if depth >= MAX_DEPTH:
        result["kind"] = "summary"
        return result

    if is_char_type(element_type):
        try:
            memory = gdb.selected_inferior().read_memory(address_int, min(count, MAX_BYTES))
            raw = bytes(memory).split(b"\x00", 1)[0]
            result["kind"] = "string"
            result["string"] = raw.decode("utf-8", errors="replace")
            return result
        except Exception:
            pass

    pointer_type = element_type.pointer()
    base_ptr = gdb.Value(address_int).cast(pointer_type)

    for index in range(min(count, MAX_CHILDREN)):
        try:
            child_value = (base_ptr + index).dereference()
            result["children"].append(
                serialize_value(
                    child_value,
                    f"{path}[{index}]",
                    seen,
                    edges,
                    context,
                    depth + 1,
                )
            )
        except Exception:
            break

    return result


def serialize_pretty_value(value, printer, path, seen, edges, context, depth):
    value_type = value.type.strip_typedefs()
    type_name = normalize_type_name(safe_string(value_type))
    summary = safe_printer_summary(printer)
    hint = safe_printer_hint(printer)
    kind = infer_pretty_kind(type_name, hint)

    result = {
        "path": path,
        "type": type_name,
        "address": format_address(safe_address(value)),
        "display": summary or safe_string(value),
        "kind": kind,
    }

    if summary is not None:
        result["summary"] = summary

    if depth >= MAX_DEPTH:
        result["kind"] = "summary"
        return result

    if kind == "string":
        result["string"] = strip_quotes(summary or safe_string(value))
        return result

    if kind in ("map", "unordered_map"):
        entries = []

        if hasattr(printer, "children"):
            iterator = iter(printer.children())
            while len(entries) < MAX_CHILDREN:
                try:
                    _, key_value = next(iterator)
                    _, mapped_value = next(iterator)
                except StopIteration:
                    break
                except Exception:
                    break

                index = len(entries)
                entries.append(
                    {
                        "name": f"[{index}]",
                        "key": serialize_value(
                            key_value,
                            f"{path}.key[{index}]",
                            seen,
                            edges,
                            context,
                            depth + 1,
                        ),
                        "value": serialize_value(
                            mapped_value,
                            f"{path}.value[{index}]",
                            seen,
                            edges,
                            context,
                            depth + 1,
                        ),
                    }
                )

        result["entries"] = entries
        result["length"] = len(entries)
        return result

    if hasattr(printer, "children"):
        children = []

        try:
            for index, (child_name, child_value) in enumerate(itertools.islice(printer.children(), MAX_CHILDREN)):
                children.append(
                    {
                        "name": child_name if child_name is not None else f"[{index}]",
                        "value": serialize_value(
                            child_value,
                            f"{path}[{index}]",
                            seen,
                            edges,
                            context,
                            depth + 1,
                        ),
                    }
                )
        except Exception:
            children = []

        result["children"] = children
        result["length"] = len(children)

    return result


def serialize_pointer_target(pointer_value, target_type, target_address, path, seen, edges, context, depth):
    try:
        address_int = int(pointer_value)
    except Exception:
        return None

    allocation = context["allocation_map"].get(target_address)
    if allocation:
        count = contiguous_element_count(allocation, target_type)
        if count:
            return serialize_contiguous_array(
                target_type,
                address_int,
                count,
                f"{path}->*",
                seen,
                edges,
                context,
                depth + 1,
            )

    try:
        return serialize_value(
            pointer_value.dereference(),
            f"{path}->*",
            seen,
            edges,
            context,
            depth + 1,
        )
    except Exception:
        return None


def serialize_value(value, path, seen, edges, context, depth=0):
    value_type = value.type.strip_typedefs()
    type_name = normalize_type_name(safe_string(value_type))
    address = format_address(safe_address(value))
    display = safe_string(value)

    result = {
        "path": path,
        "type": type_name,
        "address": address,
        "display": display,
    }

    if depth >= MAX_DEPTH:
        result["kind"] = "summary"
        return result

    code = value_type.code

    if code == gdb.TYPE_CODE_PTR:
        try:
            target_address = format_address(int(value))
        except Exception:
            target_address = None

        result["kind"] = "pointer"
        result["targetAddress"] = target_address

        if target_address and target_address != "0x0":
            edges.append({"from": path, "to": target_address, "kind": "pointer"})

        if target_address and target_address != "0x0":
            target_type = value_type.target().strip_typedefs()
            result["targetType"] = normalize_type_name(safe_string(target_type))
            register_address_type(context, target_address, target_type)

            if is_char_type(target_type):
                string_value = try_read_c_string(value)
                if string_value is not None:
                    result["string"] = string_value
                    result["kind"] = "string_pointer"
            elif target_address not in seen:
                next_seen = set(seen)
                next_seen.add(target_address)
                pointee = serialize_pointer_target(
                    value,
                    target_type,
                    target_address,
                    path,
                    next_seen,
                    edges,
                    context,
                    depth,
                )
                if pointee is not None:
                    result["pointee"] = pointee

        return result

    if code == gdb.TYPE_CODE_REF:
        result["kind"] = "reference"
        try:
            referenced = value.referenced_value()
            target_address = format_address(referenced.address)
            result["targetAddress"] = target_address
            if target_address and target_address != "0x0":
                edges.append({"from": path, "to": target_address, "kind": "reference"})
            result["value"] = serialize_value(
                referenced,
                f"{path}&",
                seen,
                edges,
                context,
                depth + 1,
            )
        except Exception:
            pass
        return result

    if code == gdb.TYPE_CODE_ARRAY:
        result["kind"] = "array"

        try:
            target_type = value_type.target().strip_typedefs()
            if is_char_type(target_type):
                result["kind"] = "string"
                result["string"] = value.string(errors="replace")
                return result
        except Exception:
            pass

        children = []
        try:
            bounds = value_type.range()
            lower = int(bounds[0])
            upper = int(bounds[1])
            result["length"] = upper - lower + 1

            for index in range(lower, min(upper, lower + MAX_CHILDREN - 1) + 1):
                children.append(
                    serialize_value(
                        value[index],
                        f"{path}[{index}]",
                        seen,
                        edges,
                        context,
                        depth + 1,
                    )
                )
        except Exception:
            pass

        result["children"] = children
        return result

    printer = try_get_printer(value)
    if printer and (is_std_type(type_name) or safe_printer_hint(printer) or safe_printer_summary(printer)):
        return serialize_pretty_value(value, printer, path, seen, edges, context, depth)

    if code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
        result["kind"] = "object"
        children = []

        try:
            fields = value_type.fields()
            for field in fields[:MAX_CHILDREN]:
                if field.name is None:
                    continue

                try:
                    child = value[field.name]
                except Exception:
                    continue

                children.append(
                    {
                        "name": field.name,
                        "value": serialize_value(
                            child,
                            f"{path}.{field.name}",
                            seen,
                            edges,
                            context,
                            depth + 1,
                        ),
                    }
                )
        except Exception:
            pass

        result["children"] = children
        return result

    result["kind"] = "scalar"
    result["value"] = parse_scalar(value)
    return result


_GDB_SOURCE_LINES_CACHE = None

def get_gdb_source_lines():
    global _GDB_SOURCE_LINES_CACHE
    if _GDB_SOURCE_LINES_CACHE is not None:
        return _GDB_SOURCE_LINES_CACHE
    lines = []
    try:
        src = gdb.execute("list 1, 1000", to_string=True)
        for line in src.splitlines():
            m = re.match(r"^(\d+)\s+(.*)$", line)
            if m:
                lno = int(m.group(1))
                txt = m.group(2)
                while len(lines) < lno:
                    lines.append("")
                lines[lno - 1] = txt
    except Exception:
        pass
    _GDB_SOURCE_LINES_CACHE = lines
    return lines


def find_symbol_decl_line(file_path, symbol_name, code_str=""):
    lines = []
    if file_path and os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
        except Exception:
            pass
    if not lines and code_str:
        lines = code_str.splitlines(True)

    if not lines:
        lines = get_gdb_source_lines()

    if not lines:
        return 0

    for line_no, line_str in enumerate(lines, 1):
        clean_line = line_str.split("//")[0]
        if re.search(r'(\->|\.)\s*' + re.escape(symbol_name) + r'\b', clean_line):
            continue
        stripped = clean_line.strip()
        if stripped.startswith("#") or stripped.startswith("return ") or stripped.startswith("struct ") or stripped.startswith("class "):
            continue

        pattern = r'\b([A-Za-z0-9_:]+(?:\s*<[^>]+>)?(?:\s*[*&])?)\s+\b' + re.escape(symbol_name) + r'\b\s*([=;,\(\[\{]|$)'
        if re.search(pattern, clean_line):
            return line_no
    return 0


def collect_frame_variables(frame, context):
    variables = []
    seen_names = set()
    try:
        block = frame.block()
    except Exception:
        return variables

    try:
        sal = frame.find_sal()
        current_line = sal.line if (sal and sal.line) else 0
        pc = frame.pc()
        file_path = sal.symtab.fullname() if (sal and sal.symtab) else ""
        if not file_path and sal and sal.symtab and sal.symtab.filename:
            file_path = sal.symtab.filename
    except Exception:
        current_line = 0
        pc = 0
        file_path = ""

    # Build DWARF decl_pc map for symbol declaration lines in this frame
    decl_pc_map = {}
    if sal and sal.symtab:
        try:
            lt = sal.symtab.linetable()
            for item in lt:
                if item.line > 0:
                    if item.line not in decl_pc_map or item.pc < decl_pc_map[item.line]:
                        decl_pc_map[item.line] = item.pc
        except Exception:
            pass

    while block:
        for symbol in block:
            if not symbol.name or symbol.name in seen_names:
                continue
            if not (symbol.is_variable or symbol.is_argument):
                continue

            # Determine line where symbol is declared
            sym_line = 0
            try:
                sym_line = getattr(symbol, "line", 0)
                if not sym_line and hasattr(symbol, "symtab_and_line") and symbol.symtab_and_line:
                    sym_line = getattr(symbol.symtab_and_line, "line", 0)
            except Exception:
                sym_line = 0

            # Fallback source-file / source-code line scan if GDB returns 0
            if not sym_line:
                sym_line = find_symbol_decl_line(file_path, symbol.name, context.get("code", ""))

            # Extra fallback: if sym_line is still 0, scan GDB source lines for first occurrence
            if not sym_line and not symbol.is_argument:
                gdb_lines = get_gdb_source_lines()
                for lidx, lstr in enumerate(gdb_lines, 1):
                    if re.search(r'\b' + re.escape(symbol.name) + r'\b', lstr):
                        sym_line = lidx
                        break

            # Temporal filter: exclude local variables whose declaration instruction PC is strictly after current PC
            if not symbol.is_argument:
                decl_pc = decl_pc_map.get(sym_line, None)
                if decl_pc is not None and pc > 0 and pc < decl_pc:
                    continue
                if sym_line > 0 and current_line > 0 and sym_line > current_line:
                    continue

            seen_names.add(symbol.name)
            try:
                value = symbol.value(frame)
                if value.is_optimized_out:
                    continue
                edges = []
                serialized = serialize_value(value, symbol.name, set(), edges, context)
                serialized["name"] = symbol.name
                serialized["isArgument"] = symbol.is_argument
                serialized["declaredLine"] = sym_line
                serialized["edges"] = edges
                variables.append(serialized)
            except Exception:
                if symbol.is_argument:
                    variables.append(
                        {
                            "name": symbol.name,
                            "kind": "unavailable",
                            "display": "<unavailable>",
                            "isArgument": True,
                            "declaredLine": sym_line,
                            "edges": [],
                        }
                    )

        if block.function is not None:
            break

        block = block.superblock

    return variables


def discover_all_types(frame, context):
    curr = frame
    all_struct_types = []
    while curr:
        try:
            block = curr.block()
            while block:
                for symbol in block:
                    if not symbol.name:
                        continue
                    try:
                        sym_type = symbol.type.strip_typedefs()
                        if sym_type.code == gdb.TYPE_CODE_PTR:
                            tgt_type = sym_type.target().strip_typedefs()
                            if tgt_type not in all_struct_types:
                                all_struct_types.append(tgt_type)
                            try:
                                val = symbol.value(curr)
                                addr_str = format_address(int(val))
                                if addr_str and addr_str != "0x0":
                                    register_address_type(context, addr_str, tgt_type)
                            except Exception:
                                pass
                        elif sym_type.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
                            if sym_type not in all_struct_types:
                                all_struct_types.append(sym_type)
                    except Exception:
                        pass
                if block.function is not None:
                    break
                block = block.superblock
        except Exception:
            pass
        curr = curr.older()
    return all_struct_types


def build_heap_previews(allocations, context, all_struct_types):
    heap_edges = []

    for allocation in allocations:
        if not allocation["active"] or not allocation["address"]:
            continue

        address = allocation["address"]
        known_types = list(context["address_types"].get(address, []))

        if not known_types:
            continue

        try:
            address_int = int(address, 16)
        except Exception:
            continue

        for target_type in known_types:
            preview_edges = []

            try:
                count = contiguous_element_count(allocation, target_type)
                if count:
                    preview = serialize_contiguous_array(
                        target_type,
                        address_int,
                        count,
                        f"heap[{address}]",
                        {address},
                        preview_edges,
                        context,
                        0,
                    )
                else:
                    preview_value = gdb.Value(address_int).cast(target_type.pointer()).dereference()
                    preview = serialize_value(
                        preview_value,
                        f"heap[{address}]",
                        {address},
                        preview_edges,
                        context,
                        0,
                    )
            except Exception:
                continue

            if preview is not None:
                allocation["preview"] = preview
                allocation["previewType"] = normalize_type_name(safe_string(target_type))

                for edge in preview_edges:
                    edge_from = edge["from"]
                    if edge_from.startswith(f"heap[{address}]."):
                        field_name = edge_from[len(f"heap[{address}]."):]
                    else:
                        field_name = edge_from
                    heap_edges.append(
                        {
                            "sourceKey": f"heap:{address}:{field_name}",
                            "to": edge["to"],
                            "kind": edge["kind"],
                        }
                    )
                break

    return heap_edges


def resolve_frame_display_line(frame):
    try:
        sal = frame.find_sal()
    except Exception:
        return None
    if not sal or not sal.line:
        return None
    sal_line = sal.line
    try:
        pc = frame.pc()
        if sal.symtab:
            lt = sal.symtab.linetable()
            entries = [(item.pc, item.line) for item in lt if item.line > 0]
            entries.sort(key=lambda x: x[0])
            past_entries = [e for e in entries if e[0] < pc]
            future_entries = [e for e in entries if e[0] > pc]
            if past_entries and future_entries:
                last_past_line = past_entries[-1][1]
                first_future_line = future_entries[0][1]
                if sal_line > last_past_line and sal_line > first_future_line:
                    return last_past_line
    except Exception:
        pass
    return sal_line


def build_snapshot():
    inferior = gdb.selected_inferior()
    allocations = collect_allocations()
    context = {
        "allocation_map": {
            allocation["address"]: allocation
            for allocation in allocations
            if allocation["active"] and allocation["address"]
        },
        "address_types": {},
    }

    try:
        current_frame = gdb.selected_frame()
    except Exception:
        return {
            "state": "exited",
            "finished": True,
            "inferiorPid": inferior.pid if inferior else None,
            "line": None,
            "file": None,
            "stack": [],
            "heap": {
                "allocations": allocations,
                "edges": [],
                "libstdcxxPrettyPrinters": LIBSTDCXX_PRINTERS_ENABLED,
            },
        }

    # Pre-discover types across frame symbols
    all_struct_types = discover_all_types(current_frame, context)

    frames = []
    heap_edges = []

    frame = current_frame
    frame_index = 0
    while frame is not None:
        try:
            sal = frame.find_sal()
        except Exception:
            sal = None
        file_name = None
        if sal and sal.symtab:
            file_name = sal.symtab.fullname() or sal.symtab.filename

        display_line = resolve_frame_display_line(frame)

        variables = collect_frame_variables(frame, context)
        for variable in variables:
            for edge in variable.get("edges", []):
                heap_edges.append(
                    {
                        "sourceKey": f"stack:{frame_index}:{edge['from']}",
                        "to": edge["to"],
                        "kind": edge["kind"],
                    }
                )

        frames.append(
            {
                "index": frame_index,
                "function": frame.name() or "<unknown>",
                "file": file_name,
                "line": display_line,
                "locals": variables,
            }
        )

        frame = frame.older()
        frame_index += 1

    heap_edges.extend(build_heap_previews(allocations, context, all_struct_types))

    # Perform temporal heap allocation reachability filtering:
    # A heap allocation is visible ONLY IF it is reachable from visible frame variables or transitive heap pointer edges
    visible_target_addresses = set()
    for f in frames:
        for var in f["locals"]:
            if var.get("targetAddress") and var["targetAddress"] != "0x0":
                visible_target_addresses.add(var["targetAddress"].lower())
            
            def collect_targets(node):
                if isinstance(node, dict):
                    if node.get("targetAddress") and node["targetAddress"] != "0x0":
                        visible_target_addresses.add(node["targetAddress"].lower())
                    for c in node.get("children", []):
                        collect_targets(c)
                    for e in node.get("entries", []):
                        collect_targets(e)
            collect_targets(var)

    changed = True
    while changed:
        changed = False
        for edge in heap_edges:
            src_key = str(edge.get("sourceKey", "")).lower()
            target_addr = str(edge.get("to", "")).lower()
            if target_addr and target_addr != "0x0" and target_addr not in visible_target_addresses:
                if src_key.startswith("heap:"):
                    parts = src_key.split(":")
                    if len(parts) >= 2:
                        src_heap_addr = parts[1]
                        if src_heap_addr in visible_target_addresses:
                            visible_target_addresses.add(target_addr)
                            changed = True

    # Filter allocations to visible allocations only
    visible_allocations = [
        alloc for alloc in allocations
        if alloc.get("active") and alloc.get("address") and alloc["address"].lower() in visible_target_addresses
    ]

    all_active_allocations = [
        alloc for alloc in allocations
        if alloc.get("active") and alloc.get("address") and alloc["address"] != "0x0"
    ]

    return {
        "state": "stopped",
        "inferiorPid": inferior.pid,
        "line": frames[0]["line"] if frames else None,
        "file": frames[0]["file"] if frames else None,
        "stack": frames,
        "heap": {
            "allocations": visible_allocations,
            "allAllocations": all_active_allocations,
            "edges": heap_edges,
            "libstdcxxPrettyPrinters": LIBSTDCXX_PRINTERS_ENABLED,
        },
    }


class VizSnapshotCommand(gdb.Command):
    def __init__(self):
        super(VizSnapshotCommand, self).__init__("viz-snapshot", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            payload = build_snapshot()
        except Exception as error:
            payload = {"state": "error", "error": safe_string(error)}

        print("__VIZ_SNAPSHOT_BEGIN__")
        print(json.dumps(payload))
        print("__VIZ_SNAPSHOT_END__")


VizSnapshotCommand()
