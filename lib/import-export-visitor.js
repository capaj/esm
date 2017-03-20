"use strict";

var assert = require("assert");
var MagicString = require("magic-string/dist/magic-string.cjs.js");
var utils = require("./utils.js");
var hasOwn = Object.prototype.hasOwnProperty;

function ImportExportVisitor() {}

module.exports = ImportExportVisitor;
var IEVp = ImportExportVisitor.prototype;

IEVp.reset = function (rootPath, codeOrNull, options) {
  if (typeof codeOrNull === "string") {
    this.code = codeOrNull;
    this.magicString = new MagicString(codeOrNull);
  } else {
    this.code = this.magicString = null;
  }

  this.bodyPaths = [];
  this.removals = [];
  this.exportedLocalNames = Object.create(null);
  this.generateLetDeclarations =
    !! utils.getOption(options, "generateLetDeclarations");
  this.modifyAST = !! utils.getOption(options, "ast");
  this.parse = utils.getOption(options, "parse");

  // Visitor methods can't modify primitive instance variables, so we have
  // to use this.nextKey.value instead.
  this.nextKey = { value: 0 };

  return this;
};

IEVp.makeUniqueKey = function () {
  return this.nextKey.value++;
};

IEVp.pad = function (newCode, oldStart, oldEnd) {
  if (this.code) {
    var oldLines = this.code.slice(oldStart, oldEnd).split("\n");
    var newLines = newCode.split("\n");
    var diff = oldLines.length - newLines.length;
    while (diff --> 0) {
      newLines.push("");
    }
    newCode = newLines.join("\n");
  }
  return newCode;
};

IEVp.overwrite = function (oldStart, oldEnd, newCode, trailing) {
  if (! this.code) {
    return this;
  }

  var padded = this.pad(newCode, oldStart, oldEnd);

  if (oldStart === oldEnd) {
    if (padded === "") {
      return this;
    }

    if (trailing) {
      this.magicString.appendLeft(oldStart, padded);
    } else {
      this.magicString.prependRight(oldStart, padded);
    }

  } else {
    this.magicString.overwrite(oldStart, oldEnd, padded);
  }

  return this;
};

IEVp.getBlockBodyPath = function (path) {
  var bodyPath = path;
  var stmtPath = bodyPath && bodyPath.parentPath;
  var insertCharIndex = bodyPath.value.start;

  while (stmtPath && stmtPath.value) {
    if (stmtPath.value.type === "Program") {
      assert.strictEqual(bodyPath.name, "body");
      insertCharIndex = stmtPath.value.start;
      break;
    }

    if (stmtPath.value.type === "BlockStatement") {
      assert.strictEqual(bodyPath.name, "body");

      if (hasOwn.call(stmtPath.value, "start")) {
        insertCharIndex = stmtPath.value.start + 1;
      } else {
        insertCharIndex = bodyPath.value[0].start;
      }

      break;
    }

    if (stmtPath.value.type === "SwitchCase") {
      assert.strictEqual(bodyPath.name, "consequent");
      insertCharIndex = bodyPath.value[0].start;
      break;
    }

    if (! Array.isArray(stmtPath.value)) {
      var block = {
        type: "BlockStatement",
        body: [bodyPath.value]
      };

      insertCharIndex = bodyPath.value.start;

      if (this.magicString) {
        this.magicString
          .appendLeft(insertCharIndex, "{")
          .prependRight(bodyPath.value.end, "}");
      }

      bodyPath.replace(block);
      stmtPath = bodyPath;
      bodyPath = stmtPath.get("body");

      break;
    }

    bodyPath = stmtPath;
    stmtPath = bodyPath.parentPath;
  }

  // Avoid hoisting above string literal expression statements such as
  // "use strict", which may depend on occurring at the beginning of
  // their enclosing scopes.
  var insertNodeIndex = 0;
  bodyPath.value.some(function (stmt, i) {
    if (stmt.type === "ExpressionStatement") {
      var expr = stmt.expression;
      if (expr.type === "StringLiteral" ||
          (expr.type === "Literal" &&
           typeof expr.value === "string")) {
        insertCharIndex = stmt.end;
        insertNodeIndex = i + 1;
        return;
      }
    }
    return true;
  });

  // Babylon represents directives like "use strict" with a .directives
  // array property on the parent node.
  var directives = bodyPath.parentPath.value.directives;
  if (directives) {
    directives.forEach(function (directive) {
      insertCharIndex = Math.max(directive.end, insertCharIndex);
    });
  }

  if (hasOwn.call(bodyPath, "_insertNodeIndex")) {
    assert.strictEqual(bodyPath._insertNodeIndex, insertNodeIndex);

  } else {
    bodyPath._insertCharIndex = insertCharIndex;
    bodyPath._insertNodeIndex = insertNodeIndex;
    bodyPath._hoistedExportsMap = Object.create(null);
    bodyPath._hoistedExportsString = "";
    bodyPath._hoistedImportsString = "";

    this.bodyPaths.push(bodyPath);
  }

  return bodyPath;
};

IEVp.hoistExports = function (exportDeclPath, mapOrString, childName) {
  // Calling this.preserveChild may remove exportDeclPath from the AST, so
  // we must record its .parentPath first.
  var pp = exportDeclPath.parentPath;
  this.preserveChild(exportDeclPath, childName);
  var bodyPath = this.getBlockBodyPath(pp);

  if (utils.isPlainObject(mapOrString)) {
    Object.keys(mapOrString).forEach(function (exported) {
      mapOrString[exported].forEach(function (local) {
        addToSpecifierMap(
          bodyPath._hoistedExportsMap,
          exported,
          local
        );
      });
    });

  } else if (typeof mapOrString === "string") {
    bodyPath._hoistedExportsString += mapOrString;
  }

  return this;
};

IEVp.hoistImports = function (importDeclPath, hoistedCode, childName) {
  // Calling this.preserveChild may remove importDeclPath from the AST, so
  // we must record its .parentPath first.
  var pp = importDeclPath.parentPath;
  this.preserveChild(importDeclPath, childName);
  var bodyPath = this.getBlockBodyPath(pp);
  bodyPath._hoistedImportsString += hoistedCode;
  return this;
};

IEVp.preserveChild = function (path, childName) {
  if (childName) {
    var childPath = path.get(childName);

    if (this.code) {
      this.overwrite(
        path.value.start,
        childPath.value.start,
        ""
      ).overwrite(
        childPath.value.end,
        path.value.end,
        ""
      );
    }

    if (this.modifyAST) {
      // Replace the given path with the child we want to preserve.
      path.replace(childPath.value);
    }

    this.visit(childPath);

  } else {
    if (this.code) {
      this.overwrite(path.value.start, path.value.end, "");
    }

    if (this.modifyAST) {
      // Schedule this path to be completely removed in finalizeHoisting.
      this.removals.push(path);
    }
  }

  return this;
};

IEVp.finalizeHoisting = function () {
  this.bodyPaths.forEach(function (bodyPath) {
    var parts = [];

    var namedExports = toModuleExport(bodyPath._hoistedExportsMap);
    if (namedExports) {
      parts.push(namedExports);
    }

    if (bodyPath._hoistedExportsString) {
      parts.push(bodyPath._hoistedExportsString);
    }

    if (bodyPath._hoistedImportsString) {
      parts.push(bodyPath._hoistedImportsString);
    }

    if (parts.length > 0) {
      var codeToInsert = parts.join("");

      if (this.magicString) {
        this.magicString.prependRight(
          bodyPath._insertCharIndex,
          codeToInsert
        );
      }

      if (this.modifyAST) {
        var ast = this.parse(codeToInsert);
        if (ast.type === "File") ast = ast.program;
        assert.strictEqual(ast.type, "Program");
        var insertArgs = ast.body;
        insertArgs.unshift(bodyPath._insertNodeIndex);
        bodyPath.insertAt.apply(bodyPath, insertArgs);
      }
    }

    delete bodyPath._insertCharIndex;
    delete bodyPath._insertNodeIndex;
    delete bodyPath._hoistedExportsMap;
    delete bodyPath._hoistedExportsString;
    delete bodyPath._hoistedImportsString;
  }, this);

  // Just in case we call finalizeHoisting again, don't hoist anything.
  this.bodyPaths.length = 0;

  this.removals.forEach(function (declPath) {
    declPath.replace();
  });

  // Just in case we call finalizeHoisting again, don't remove anything.
  this.removals.length = 0;
};

IEVp.visitImportDeclaration = function (path) {
  var decl = path.value;
  var parts = [];

  if (decl.specifiers.length > 0) {
    parts.push(this.generateLetDeclarations ? "let " : "var ");

    decl.specifiers.forEach(function (s, i) {
      var isLast = i === decl.specifiers.length - 1;
      parts.push(
        s.local.name,
        isLast ? ";" : ","
      );
    });
  }

  parts.push(toModuleImport(
    this._getSourceString(decl),
    computeSpecifierMap(decl.specifiers),
    this.makeUniqueKey()
  ));

  this.hoistImports(path, parts.join(""));

  return false;
};

IEVp.visitExportAllDeclaration = function (path) {
  var decl = path.value;
  var parts = [
    this.pad("module.importSync(", decl.start, decl.source.start),
    this._getSourceString(decl),
    this.pad(
      ",{'*':function(v,k){exports[k]=v;}}," +
        this.makeUniqueKey() + ");",
      decl.source.end,
      decl.end
    )
  ];

  this.hoistExports(path, parts.join(""));

  return false;
};

IEVp.visitExportDefaultDeclaration = function (path) {
  var decl = path.value;
  var dd = decl.declaration;

  if (dd.id && (dd.type === "FunctionDeclaration" ||
                dd.type === "ClassDeclaration")) {
    // If the exported default value is a function or class declaration,
    // it's important that the declaration be visible to the rest of the
    // code in the exporting module, so we must avoid compiling it to a
    // named function or class expression.
    this.hoistExports(path, {
      "default": [dd.id.name]
    }, "declaration");

  } else {
    // Otherwise, since the exported value is an expression, it's
    // important that we wrap it with parentheses, in case it's something
    // like a comma-separated sequence expression.
    this.overwrite(decl.start, dd.start, exportDefaultPrefix);

    var declPath = path.get("declaration");

    this.visit(declPath);

    this.overwrite(dd.end, decl.end, exportDefaultSuffix, true);

    if (this.modifyAST) {
      // A Function or Class declaration has become an expression on the
      // right side of the _exportDefaultPrefix assignment above so change
      // the AST appropriately
      if (dd.type === "FunctionDeclaration") {
        dd.type = "FunctionExpression";
      } else if (dd.type === "ClassDeclaration") {
        dd.type = "ClassExpression";
      }

      path.replace(this._buildExportDefaultStatement(declPath.value));
    }
  }
};

const exportDefaultPrefix =
  'module.export("default",exports.default=(';

const exportDefaultSuffix = "));";

IEVp._buildExportDefaultStatement = function (declaration) {
  var ast = this.parse(
    exportDefaultPrefix + "VALUE" + exportDefaultSuffix);

  if (ast.type === "File") {
    ast = ast.program;
  }

  assert.strictEqual(ast.type, "Program");

  var stmt = ast.body[0];
  assert.strictEqual(stmt.type, "ExpressionStatement");
  assert.strictEqual(stmt.expression.type, "CallExpression");

  var arg1 = stmt.expression.arguments[1];
  assert.strictEqual(arg1.right.type, "Identifier");
  assert.strictEqual(arg1.right.name, "VALUE");

  // Replace the VALUE identifier with the desired declaration.
  arg1.right = declaration;

  return stmt;
};

IEVp.visitExportNamedDeclaration = function (path) {
  var decl = path.value;
  var dd = decl.declaration;

  if (dd) {
    var specifierMap = Object.create(null);
    var addNameToMap = function (name) {
      addToSpecifierMap(specifierMap, name, name);
    };

    if (dd.id && (dd.type === "ClassDeclaration" ||
                  dd.type === "FunctionDeclaration")) {
      addNameToMap(dd.id.name);
    } else if (dd.type === "VariableDeclaration") {
      dd.declarations.forEach(function (ddd) {
        utils.getNamesFromPattern(ddd.id).forEach(addNameToMap);
      });
    }

    this.hoistExports(path, specifierMap, "declaration");
    this.addExportedLocalNames(specifierMap);

    return;
  }

  if (decl.specifiers) {
    var specifierMap = computeSpecifierMap(decl.specifiers);

    if (decl.source) {
      if (specifierMap) {
        var newMap = Object.create(null);

        Object.keys(specifierMap).forEach(function (exported) {
          specifierMap[exported].forEach(function (local) {
            addToSpecifierMap(newMap, local, "exports." + exported);
          });
        });

        specifierMap = newMap;
      }

      // Even though the compiled code uses module.importSync, it should
      // still be hoisted as an export, i.e. before actual imports.
      this.hoistExports(path, toModuleImport(
        this._getSourceString(decl),
        specifierMap,
        this.makeUniqueKey()
      ));

    } else {
      this.hoistExports(path, specifierMap);
      this.addExportedLocalNames(specifierMap);
    }
  }

  return false;
};

// Gets a string representation (including quotes) from an import or
// export declaration node.
IEVp._getSourceString = function (decl) {
  if (this.code) {
    return this.code.slice(
      decl.source.start,
      decl.source.end
    );
  }

  assert.strictEqual(typeof decl.source.value, "string");

  return JSON.stringify(decl.source.value);
};

IEVp.addExportedLocalNames = function (specifierMap) {
  if (specifierMap) {
    var exportedLocalNames = this.exportedLocalNames;
    Object.keys(specifierMap).forEach(function (exported) {
      specifierMap[exported].forEach(function (local) {
        // It's tempting to record the exported name as the value here,
        // instead of true, but there can be more than one exported name
        // per local variable, and we don't actually use the exported
        // name(s) in the assignmentVisitor, so it's not worth the added
        // complexity of tracking unused information.
        exportedLocalNames[local] = true;
      });
    });
  }
};

// Returns a map from {im,ex}ported identifiers to lists of local variable
// names bound to those identifiers.
function computeSpecifierMap(specifiers) {
  var specifierMap;

  specifiers.forEach(function (s) {
    var local =
      s.type === "ExportDefaultSpecifier" ? "default" :
      s.type === "ExportNamespaceSpecifier" ? "*" :
      s.local.name;

    var __ported = // The IMported or EXported name.
      s.type === "ImportSpecifier" ? s.imported.name :
      s.type === "ImportDefaultSpecifier" ? "default" :
      s.type === "ImportNamespaceSpecifier" ? "*" :
      (s.type === "ExportSpecifier" ||
       s.type === "ExportDefaultSpecifier" ||
       s.type === "ExportNamespaceSpecifier") ? s.exported.name :
      null;

    if (typeof local !== "string" ||
        typeof __ported !== "string") {
      return;
    }

    specifierMap = addToSpecifierMap(
      specifierMap || Object.create(null),
      __ported,
      local
    );
  });

  return specifierMap;
}

function addToSpecifierMap(map, __ported, local) {
  assert.strictEqual(typeof __ported, "string");
  assert.strictEqual(typeof local, "string");

  var locals = map[__ported] || [];

  if (locals.indexOf(local) < 0) {
    locals.push(local);
  }

  map[__ported] = locals;

  return map;
}

function toModuleImport(source, specifierMap, uniqueKey) {
  var parts = ["module.importSync(", source];
  var importedNames = specifierMap && Object.keys(specifierMap);

  if (! importedNames || importedNames.length === 0) {
    parts.push(");");
    return parts.join("");
  }

  parts.push(",{");

  importedNames.forEach(function (imported, i) {
    var isLast = i === importedNames.length - 1;
    var locals = specifierMap[imported];
    var valueParam = safeParam("v", locals);
    var bind = "";

    parts.push(
      JSON.stringify(imported),
      ":function(", valueParam
    );

    if (imported === "*") {
      // There can be only one namespace import/export specifier.
      assert.strictEqual(locals.length, 1);
      var local = locals[0];

      // We must be handling either an ImportNamespaceSpecifier or an
      // ExportNamespaceSpecifier. We initialize the target object as the
      // argument to a .bind method call on the setter function, so that
      // we can refer to it as `this` inside the setter function.
      bind = ".bind(" + local + "={})";
      local = "this";

      // When the imported name is "*", the setter function may be called
      // multiple times, and receives an additional parameter specifying
      // the name of the property to be set.
      var nameParam = safeParam("n", [local, valueParam]);

      parts.push(
        ",", nameParam, "){",
        // The local variable should have been initialized as an empty
        // object when the variable was declared.
        local, "[", nameParam, "]=", valueParam
      );

    } else {
      // Multiple local variables become a compound assignment.
      parts.push("){", locals.join("="), "=", valueParam);
    }

    parts.push("}");

    if (bind.length > 0) {
      parts.push(bind);
    }

    if (! isLast) {
      parts.push(",");
    }
  });

  parts.push("}," + uniqueKey + ");");

  return parts.join("");
}

function safeParam(param, locals) {
  if (locals.indexOf(param) < 0) {
    return param;
  }
  return safeParam("_" + param, locals);
}

function toModuleExport(specifierMap) {
  var exportedKeys = specifierMap && Object.keys(specifierMap);

  if (! exportedKeys ||
      exportedKeys.length === 0) {
    return "";
  }

  var parts = ["module.export({"];

  exportedKeys.forEach(function (exported, i) {
    var isLast = i === exportedKeys.length - 1;
    var locals = specifierMap[exported];

    assert.strictEqual(locals.length, 1);

    parts.push(
      exported,
      ":function(){return ",
      locals[0],
      isLast ? "}" : "},"
    );
  });

  parts.push("});");

  return parts.join("");
}