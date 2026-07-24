package com.modokiengine.capacitor.ota;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A tiny recursive-descent JSON parser — TEST-ONLY. Its one job is reading the shared
 * golden-vectors fixture on a plain JVM with no dependencies (no Gradle/Android SDK/org.json
 * on the classpath here). The real shipped Android plugin uses org.json, which is part of
 * the Android platform SDK, not this class. Objects decode to LinkedHashMap<String,Object>,
 * arrays to List<Object>, numbers to Double or Long, "null" to null.
 */
final class MinimalJson {
  private final String s;
  private int i;

  private MinimalJson(String s) { this.s = s; }

  static Object parse(String json) {
    MinimalJson p = new MinimalJson(json);
    p.skipWs();
    Object v = p.parseValue();
    p.skipWs();
    return v;
  }

  private void skipWs() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

  private Object parseValue() {
    char c = s.charAt(i);
    if (c == '{') return parseObject();
    if (c == '[') return parseArray();
    if (c == '"') return parseString();
    if (c == 't') { expect("true"); return Boolean.TRUE; }
    if (c == 'f') { expect("false"); return Boolean.FALSE; }
    if (c == 'n') { expect("null"); return null; }
    return parseNumber();
  }

  private void expect(String lit) {
    if (!s.startsWith(lit, i)) throw new RuntimeException("expected " + lit + " at " + i);
    i += lit.length();
  }

  private Map<String, Object> parseObject() {
    Map<String, Object> out = new LinkedHashMap<>();
    i++; // {
    skipWs();
    if (s.charAt(i) == '}') { i++; return out; }
    while (true) {
      skipWs();
      String key = parseString();
      skipWs();
      if (s.charAt(i) != ':') throw new RuntimeException("expected : at " + i);
      i++;
      skipWs();
      out.put(key, parseValue());
      skipWs();
      if (s.charAt(i) == ',') { i++; continue; }
      if (s.charAt(i) == '}') { i++; break; }
      throw new RuntimeException("expected , or } at " + i);
    }
    return out;
  }

  private List<Object> parseArray() {
    List<Object> out = new ArrayList<>();
    i++; // [
    skipWs();
    if (s.charAt(i) == ']') { i++; return out; }
    while (true) {
      skipWs();
      out.add(parseValue());
      skipWs();
      if (s.charAt(i) == ',') { i++; continue; }
      if (s.charAt(i) == ']') { i++; break; }
      throw new RuntimeException("expected , or ] at " + i);
    }
    return out;
  }

  private String parseString() {
    if (s.charAt(i) != '"') throw new RuntimeException("expected string at " + i);
    i++;
    StringBuilder sb = new StringBuilder();
    while (s.charAt(i) != '"') {
      char c = s.charAt(i);
      if (c == '\\') {
        i++;
        char esc = s.charAt(i);
        switch (esc) {
          case '"': sb.append('"'); break;
          case '\\': sb.append('\\'); break;
          case '/': sb.append('/'); break;
          case 'n': sb.append('\n'); break;
          case 't': sb.append('\t'); break;
          case 'r': sb.append('\r'); break;
          case 'b': sb.append('\b'); break;
          case 'f': sb.append('\f'); break;
          case 'u':
            sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
            i += 4;
            break;
          default: throw new RuntimeException("bad escape at " + i);
        }
        i++;
      } else {
        sb.append(c);
        i++;
      }
    }
    i++; // closing "
    return sb.toString();
  }

  private Object parseNumber() {
    int start = i;
    if (s.charAt(i) == '-') i++;
    while (i < s.length() && (Character.isDigit(s.charAt(i)) || s.charAt(i) == '.' || s.charAt(i) == 'e' || s.charAt(i) == 'E' || s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
    String num = s.substring(start, i);
    if (num.contains(".") || num.contains("e") || num.contains("E")) return Double.parseDouble(num);
    return Long.parseLong(num);
  }
}
