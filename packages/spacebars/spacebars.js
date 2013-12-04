
Spacebars = {};

var makeStacheTagStartRegex = function (r) {
  return new RegExp(r.source + /(?![{>!#/])/.source,
                    r.ignoreCase ? 'i' : '');
};

var prettyOffset = function (code, pos) {
  var codeUpToPos = code.substring(0, pos);
  var startOfLine = codeUpToPos.lastIndexOf('\n') + 1;
  var indexInLine = pos - startOfLine; // 0-based
  var lineNum = codeUpToPos.replace(/[^\n]+/g, '').length + 1; // 1-based
  return "line " + lineNum + ", offset " + indexInLine;
};

var starts = {
  ELSE: makeStacheTagStartRegex(/^\{\{\s*else(?=[\s}])/i),
  DOUBLE: makeStacheTagStartRegex(/^\{\{\s*(?!\s)/),
  TRIPLE: makeStacheTagStartRegex(/^\{\{\{\s*(?!\s)/),
  COMMENT: makeStacheTagStartRegex(/^\{\{\s*!/),
  INCLUSION: makeStacheTagStartRegex(/^\{\{\s*>\s*(?!\s)/),
  BLOCKOPEN: makeStacheTagStartRegex(/^\{\{\s*#\s*(?!\s)/),
  BLOCKCLOSE: makeStacheTagStartRegex(/^\{\{\s*\/\s*(?!\s)/)
};

var ends = {
  DOUBLE: /^\s*\}\}/,
  TRIPLE: /^\s*\}\}\}/
};

Spacebars.starts = starts;

// Parse a tag at `pos` in `inputString`.  Succeeds or errors.
Spacebars.parseStacheTag = function (inputString, pos, options) {
  pos = pos || 0;
  var startPos = pos;
  var str = inputString.slice(pos);

  var lexer = new JSLexer(inputString);

  var advance = function (amount) {
    str = str.slice(amount);
    pos += amount;
  };

  var run = function (regex) {
    // regex is assumed to start with `^`
    var result = regex.exec(str);
    if (! result)
      return null;
    var ret = result[0];
    advance(ret.length);
    return ret;
  };

  var scanToken = function () {
    lexer.divisionPermitted = false;
    lexer.pos = pos;
    return lexer.next();
  };

  var scanIdentifier = function (isFirstInPath) {
    var tok = scanToken();
    // We don't care about overlap with JS keywords,
    // but accept "true", "false", and "null" as identifiers
    // only if not isFirstInPath.
    if (! (tok.type() === 'IDENTIFIER' ||
           tok.type() === 'KEYWORD' ||
           ((! isFirstInPath) && (tok.type() === 'BOOLEAN' ||
                                  tok.type() === 'NULL')))) {
      expected('IDENTIFIER');
    }
    var text = tok.text();
    advance(text.length);
    return text;
  };

  //var scanDottedIdentifier = function () {
  //  var name = scanIdentifier();
  //  while (run(/^\./))
  //    name += '.' + scanIdentifier();
  //  return name;
  //};

  var scanPath = function () {
    var segments = [];

    // handle initial `.`, `..`, `./`, `../`, `../..`, `../../`, etc
    var dots;
    if ((dots = run(/^[\.\/]+/))) {
      var ancestorStr = '.'; // eg `../../..` maps to `....`
      var endsWithSlash = /\/$/.test(dots);

      if (endsWithSlash)
        dots = dots.slice(0, -1);

      _.each(dots.split('/'), function(dotClause, index) {
        if (index === 0) {
          if (dotClause !== '.' && dotClause !== '..')
            expected("`.`, `..`, `./` or `../`");
        } else {
          if (dotClause !== '..')
            expected("`..` or `../`");
        }

        if (dotClause === '..')
          ancestorStr += '.';
      });

      segments.push(ancestorStr);

      if (!endsWithSlash)
        return segments;
    }

    while (true) {
      // scan a path segment

      if (run(/^\[/)) {
        var seg = run(/^[\s\S]*?\]/);
        if (! seg)
          error("Unterminated path segment");
        seg = seg.slice(0, -1);
        if (! seg && ! segments.length)
          error("Path can't start with empty string");
        segments.push(seg);
      } else {
        var id = scanIdentifier(! segments.length);
        if (id === 'this' && ! segments.length) {
          // initial `this`
          segments.push('.');
        } else {
          segments.push(id);
        }
      }

      var sep = run(/^[\.\/]/);
      if (! sep)
        break;
    }

    return segments;
  };

  // scan an argument; succeeds or errors
  var scanArg = function (notKeyword) {
    // all args have `type` and possibly `key`
    var tok = scanToken();
    var tokType = tok.type();
    var text = tok.text();

    if (/^[\.\[]/.test(str) && tokType !== 'NUMBER')
      return ['PATH', scanPath()];

    if (tokType === 'PUNCTUATION' && text === '-') {
      // unary minus
      advance(text.length);
      var numberTok = scanToken();
      if (numberTok.type() !== 'NUMBER')
        expected('identifier, number, string, boolean, or null');
      advance(numberTok.text().length);
      return ['NUMBER', -Number(numberTok.text())];
    }

    if (tokType === 'BOOLEAN') {
      advance(text.length);
      return ['BOOLEAN', tok.text() === 'true'];
    } else if (tokType === 'NULL') {
      advance(text.length);
      return ['NULL', null];
    } else if (tokType === 'NUMBER') {
      advance(text.length);
      return ['NUMBER', Number(tok.text())];
    } else if (tokType === 'STRING') {
      advance(text.length);
      // single quote to double quote
      if (text.slice(0, 1) === "'")
        text = '"' + text.slice(1, -1) + '"';
      // replace line continuations with `\n`
      text = text.replace(/[\r\n\u000A\u000D\u2028\u2029]/g, 'n');
      return ['STRING', JSON.parse(text)];
    } else if (tokType === 'IDENTIFIER' || tokType === 'KEYWORD') {
      if ((! notKeyword) &&
          /^\s*=/.test(str.slice(text.length))) {
        // it's a keyword argument!
        advance(text.length);
        run(/^\s*=\s*/);
        // recurse to scan value, disallowing a second `=`.
        var arg = scanArg(true);
        arg.push(text); // add third element for key
        return arg;
      }
      return ['PATH', scanPath()];
    } else {
      expected('identifier, number, string, boolean, or null');
    }
  };

  var type;

  var error = function (msg) {
    msg = msg + " at " + prettyOffset(inputString, pos);
    if (options && options.sourceName)
      msg += " in " + options.sourceName;
    throw new Error(msg);
  };
  var expected = function (what) {
    error('Expected ' + what + ', found "' + str.slice(0,5) + '"');
  };

  // must do ELSE first; order of others doesn't matter

  if (run(starts.ELSE)) type = 'ELSE';
  else if (run(starts.DOUBLE)) type = 'DOUBLE';
  else if (run(starts.TRIPLE)) type = 'TRIPLE';
  else if (run(starts.COMMENT)) type = 'COMMENT';
  else if (run(starts.INCLUSION)) type = 'INCLUSION';
  else if (run(starts.BLOCKOPEN)) type = 'BLOCKOPEN';
  else if (run(starts.BLOCKCLOSE)) type = 'BLOCKCLOSE';
  else
    error('Unknown stache tag starting with "' + str.slice(0,5) + '"');

  var tag = { type: type };

  if (type === 'COMMENT') {
    var result = run(/^[\s\S]*?\}\}/);
    if (! result)
      error("Unclosed comment");
    tag.value = result.slice(0, -2);
  } else if (type === 'BLOCKCLOSE') {
    tag.path = scanPath();
    if (! run(ends.DOUBLE))
      expected('`}}`');
  } else if (type === 'ELSE') {
    if (! run(ends.DOUBLE))
      expected('`}}`');
  } else {
    // DOUBLE, TRIPLE, BLOCKOPEN, INCLUSION
    tag.path = scanPath();
    tag.args = [];
    while (true) {
      run(/^\s*/);
      if (type === 'TRIPLE') {
        if (run(ends.TRIPLE))
          break;
        else if (str.charAt(0) === '}')
          expected('`}}}`');
      } else {
        if (run(ends.DOUBLE))
          break;
        else if (str.charAt(0) === '}')
          expected('`}}`');
      }
      tag.args.push(scanArg());
      if (run(/^(?=[\s}])/) !== '')
        expected('space');
    }
  }

  var checkTag = function (tag) {
    if (tag.type === 'INCLUSION') {
      // throw error on >1 positional arguments
      var numPosArgs = 0;
      var args = tag.args;
      for (var i = 0; i < args.length; i++)
        if (args[i].length === 2)
          numPosArgs++;
      if (numPosArgs > 1)
        error("Only one positional argument is allowed here");
    }
  };

  checkTag(tag);

  tag.charPos = startPos;
  tag.charLength = pos - startPos;
  return tag;
};

var randomLetters = function () {
  var letters = "abcdefghijklmnopqrstuvwxyz";
  var str = '';
  for (var i = 0; i < 10; ++i)
    str += Random.choice(letters);
  return str;
};

var ALLOW_ALL_STACHE = 0;
var ALLOW_NO_STACHE = 1;
var ALLOW_NO_COMPONENTS = 2;

// Double- vs triple-stache is really only a sensible distinction
// at text level.  In other contexts, we mandate one or the other
// or treat them the same.  The reason is that Meteor UI's
// HTML-generation API is high-level and does the encoding for us.
//
// In a comment, allow either and perform no escaping.  You can have
// any text in a comment except `--`.
var INTERPOLATE_COMMENT = 1;
// Only allow double in `<a href="{{foo}}">` or `<a href={{foo}}>`.
var INTERPOLATE_ATTR_VALUE = 2;

var tokenizeHtml = function (html, preString, postString, tagLookup, options) {
  var tokens = HTML5Tokenizer.tokenize(html);

  var out = [];

  var error = function (msg) {
    if (options && options.sourceName)
      msg = msg + " in " + options.sourceName;
    throw new Error(msg);
  };

  var extractTags = function (str, mode, customErrorMessage) {
    // Scan `str` for substrings that are actually our
    // alphabetic markers that represent stache tags
    // (or entire blocks, which have `.type` of `'block'`
    // and `.isBlock` of `true`).
    //
    // Return either a single string (if there are no stache
    // tags) or an array, each element of which is either a
    // string or a tag or block.
    //
    // The `mode` flag can be used to restrict the allowed
    // tag types, for example by setting it to ALLOW_NO_STACHE
    // to disallow stache tags completely (and verify that
    // there are none).  If this flag is used,
    // `customErrorMessage` may optionally be given to replace
    // the default error message of "Can't use this stache tag
    // at this position in an HTML tag".
    if (! str)
      return '';

    var buf = [];
    var lastPos = 0;
    var pos;
    while ((pos = str.indexOf(preString, lastPos)) >= 0) {
      if (pos > lastPos)
        buf.push(str.slice(lastPos, pos));
      var idStart = pos + preString.length;
      var idEnd = str.indexOf(postString, idStart);
      if (idEnd < 0)
        error("error extracting tags"); // shouldn't happen
      var tagId = str.slice(idStart, idEnd);
      var tag = tagLookup.getTag(tagId);
      if (mode) {
        if (mode === ALLOW_NO_STACHE ||
            (mode === ALLOW_NO_COMPONENTS &&
             (tag.isBlock || tag.type === 'INCLUSION')))
          error(
            (customErrorMessage ||
             "Can't use this stache tag at this position " +
             "in an HTML tag") + ", at " +
              tagLookup.prettyOffset(tagId));
      }
      buf.push(tag);
      lastPos = idEnd + postString.length;
    }
    if (lastPos < str.length)
      buf.push(str.slice(lastPos));

    if (buf.length === 1 && typeof buf[0] === "string")
      return buf[0];

    return buf;
  };

  // Run extractTags(chrs) and make sure there are no stache tags,
  // because they are illegal in this position (e.g. HTML tag
  // name).
  var noStache = function (str, customMessage) {
    return extractTags(str, ALLOW_NO_STACHE, customMessage);
  };

  // Like `extractTags(str)`, but doesn't allow block helpers
  // or inclusions.
  var extractStringTags = function (str, customMessage) {
    return extractTags(str, ALLOW_NO_COMPONENTS, customMessage);
  };

  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];
    if (tok.type === 'Characters' ||
        tok.type === 'SpaceCharacters') {
      var s = tok.data;
      // combine multiple adjacent "Characters"; this is
      // necessary to make sure we extract the tags properly.
      while (tokens[i+1] &&
             (tokens[i+1].type === 'Characters' ||
              tokens[i+1].type === 'SpaceCharacters')) {
        tok = tokens[++i];
        s += tok.data;
      }
      out.push({type: 'Characters',
                data: extractTags(s)});
    } else if (tok.type === 'EndTag') {
      out.push({type: 'EndTag',
                name: noStache(tok.name)});
    } else if (tok.type === 'Doctype') {
      out.push({type: 'DocType',
                name: noStache(tok.name),
                correct: tok.correct,
                publicId: tok.publicId && noStache(tok.publicId),
                systemId: tok.systemId && noStache(tok.systemId)
               });
    } else if (tok.type === 'Comment') {
      out.push({type: 'Comment',
                data: extractStringTags(tok.data)});
    } else if (tok.type === 'StartTag') {
      out.push({ type: 'StartTag',
                 name: noStache(tok.name),
                 data: _.map(tok.data, function (kv) {
                   return {
                     nodeName: extractStringTags(kv.nodeName),
                     nodeValue: extractStringTags(kv.nodeValue) };
                 }),
                 self_closing: tok.self_closing
               });
    } else {
      // ignore (ParseError, EOF)
    }
  }

  return out;
};

Spacebars.parse = function (inputString, options) {
  // first, scan for all the stache tags

  var stacheTags = [];

  var pos = 0;
  while (pos < inputString.length) {
    pos = inputString.indexOf('{{', pos);
    if (pos < 0) {
      pos = inputString.length;
    } else {
      var tag = Spacebars.parseStacheTag(
        inputString, pos,
        options && { sourceName: options.sourceName });
      stacheTags.push(tag);
      pos += tag.charLength;
    }
  }

  var error = function (msg) {
    if (options && options.sourceName)
      msg = msg + " in " + options.sourceName;
    throw new Error(msg);
  };

  // now build a tree where block contents are put into an object
  // with `type:'block'`.  Also check that block stache tags match.

  var parseBlock = function (openTagIndex) {
    var isTopLevel = (openTagIndex < 0);
    var block = {
      type: 'block',
      isBlock: true, // always true for a block; just a type marker
      // openTag, closeTag must be present except at top level
      openTag: null,
      closeTag: null,
      bodyChildren: [], // tags and blocks
      bodyTokens: null, // filled in by a subsequent recursive pass
      // if elseTag is present, then elseChildren and elseTokens
      // must be too.
      elseTag: null,
      elseChildren: null,
      elseTokens: null
    };
    var children = block.bodyChildren; // repointed to elseChildren later
    if (! isTopLevel)
      block.openTag = stacheTags[openTagIndex];


    for (var i = (isTopLevel ? 0 : openTagIndex + 1);
         i < stacheTags.length && ! block.closeTag;
         i++) {

      var t = stacheTags[i];
      if (t.type === 'BLOCKOPEN') {
        // recurse
        var b = parseBlock(i);
        children.push(b);
        while (stacheTags[i] !== b.closeTag)
          i++;
      } else if (t.type === 'BLOCKCLOSE') {
        var name = t.path.join('.');
        if (isTopLevel)
          error("Unexpected close tag `" + name + "` at " +
                prettyOffset(inputString, t.charPos));
        if (name !== block.openTag.path.join('.'))
          error("Close tag at " +
                prettyOffset(inputString, t.charPos) +
                " doesn't match `" +
                block.openTag.path.join('.') +
                "`, found `" + name + "`");
        block.closeTag = t;
      } else if (t.type === 'ELSE') {
        if (isTopLevel)
          error("Unexpected `{{else}}` at " +
                prettyOffset(inputString, t.charPos));
        if (block.elseTag)
          error("Duplicate `{{else}}` at " +
                prettyOffset(inputString, t.charPos));
        block.elseTag = t;
        children = [];
        block.elseChildren = children;
      } else {
        children.push(t);
      }
    }

    if (! isTopLevel && ! block.closeTag)
      error("Unclosed `" + block.openTag.path.join('.') +
            "` tag at top level");

    return block;
  };

  // get a tree of all the stache tags as a top-level "block"
  // whose bodyChildren are the sub-blocks and other non-block
  // stache tags.
  var tree = parseBlock(-1);

  var preString = randomLetters();
  var postString = randomLetters();
  var nextId = 1;

  var tagEnd = function (t) { return t.charPos + t.charLength; };

  var idLookup = {};

  var tagLookup = {
    prettyOffset: function (tagId) {
      var t = idLookup[tagId];
      return t ? prettyOffset(
        inputString, (t.isBlock ? t.openTag : t).charPos) :
      "(unknown)";
    },
    getTag: function (tagId) {
      return idLookup[tagId];
    }
  };

  var tokenizeBlock = function (block) {
    // Strategy: replace all child tags and blocks in the HTML
    // with random identifiers before passing to the tokenizer!
    // Because the random identifiers consist of ASCII letters,
    // they will be parsed as tokens or substrings of tokens.

    var isTopLevel = ! block.openTag;
    var hasElse = !! block.elseTag;

    var getTokens = function (children, startPos, endPos) {
      var html = '';
      var pos = startPos;
      _.each(children, function (t) {
        html += inputString.slice(
          pos, (t.isBlock ? t.openTag : t).charPos);
        idLookup[nextId] = t;
        html += preString + (nextId++) + postString;
        pos = tagEnd(t.isBlock ? t.closeTag : t);

        if (t.isBlock)
          tokenizeBlock(t); // recurse
      });
      html += inputString.slice(pos, endPos);

      return tokenizeHtml(
        html, preString, postString, tagLookup,
        options && { sourceName: options.sourceName });
    };

    var bodyStart = (isTopLevel ? 0 : tagEnd(block.openTag));
    var bodyEnd = (isTopLevel ? inputString.length :
                   (hasElse ? block.elseTag.charPos :
                    block.closeTag.charPos));

    block.bodyTokens = getTokens(block.bodyChildren, bodyStart, bodyEnd);

    if (hasElse) {
      var elseStart = tagEnd(block.elseTag);
      var elseEnd = block.closeTag.charPos;

      block.elseTokens = getTokens(block.elseChildren, elseStart, elseEnd);
    }
  };

  tokenizeBlock(tree);

  return tree;
};

// XXX beef this up from ui/render2.js
var toJSLiteral = function (obj) {
  // http://timelessrepo.com/json-isnt-a-javascript-subset
  return (JSON.stringify(obj)
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029'));
};

// XXX use toObjectLiteralKey from ui/render2.js
// takes an object whose keys and values are strings of
// JavaScript source code and returns the source code
// of an object literal.
var makeObjectLiteral = function (obj) {
  var buf = [];
  buf.push('{');
  for (var k in obj) {
    if (buf.length > 1)
      buf.push(', ');
    buf.push(k, ': ', obj[k]);
  }
  buf.push('}');
  return buf.join('');
};

// Generates a render function (i.e. JS source code) from a template
// string or a pre-parsed template string.  Consumes the AST from the
// parser, which consists of HTML tokens with embedded stache tags.  A
// "block" (i.e. `{{#foo}}...{{/foo}}`) is represented as a single tag
// (always as part of an HTML "Characters" token), which has content
// that contains more HTML.
Spacebars.compile = function (inputString, options) {
  var tree;
  if (typeof inputString === 'object') {
    tree = inputString; // allow passing parse tree
  } else {
    tree = Spacebars.parse(
      inputString,
      options && { sourceName: options.sourceName });
  }

  // XXX refactor to unify instances of this helper.
  // Spacebars should probably be a class representing
  // a Spacebars processor, with static methods aliased,
  // e.g. `Spacebars.compile` calls `(new Spacebars).compile`.
  var error = function (msg) {
    if (options && options.sourceName)
      msg = msg + " in " + options.sourceName;
    throw new Error(msg);
  };

  // `path` is an array of at least one string
  var codeGenPath = function (path, funcInfo) {
    funcInfo.usedSelf = true;

    var code = 'self.lookup(' + toJSLiteral(path[0]) + ')';

    if (path.length > 1) {
      code = 'Spacebars.index(' + code + ', ' +
        _.map(path.slice(1), toJSLiteral).join(', ') + ')';
    }

    return code;
  };

  // returns: array of source strings, or null if no
  // args at all.
  //
  // if forComponentWithOpts is truthy, perform
  // component invocation argument handling.
  // forComponentWithOpts is a map from name of keyword
  // argument to source code.  For example,
  // `{ content: "Component.extend(..." }`.
  // In this case, we return an array of exactly one string
  // containing the source code of an object literal.
  var codeGenArgs = function (tagArgs, funcInfo,
                              forComponentWithOpts) {
    var options = null; // source -> source
    var args = null; // [source]

    var forComponent = !! forComponentWithOpts;

    _.each(tagArgs, function (arg, i) {
      var argType = arg[0];
      var argValue = arg[1];

      var argCode;
      switch (argType) {
      case 'STRING':
      case 'NUMBER':
      case 'BOOLEAN':
      case 'NULL':
        argCode = toJSLiteral(argValue);
        break;
      case 'PATH':
        argCode = codeGenPath(argValue, funcInfo);
        break;
      default:
        error("Unexpected arg type: " + argType);
      }

      if (arg.length > 2) {
        // keyword argument (represented as [type, value, name])
        options = (options || {});
        if (! (forComponentWithOpts &&
               (arg[2] in forComponentWithOpts))) {
          options[toJSLiteral(arg[2])] = argCode;
        }
      } else {
        // positional argument
        args = (args || []);
        args.push(argCode);
      }
    });

    if (forComponent) {
      _.each(forComponentWithOpts, function (v, k) {
        options = (options || {});
        options[toJSLiteral(k)] = v;
      });
      // put options as dictionary at beginning of args for component
      args = (args || []);
      args.unshift(options ? makeObjectLiteral(options) : 'null');
    } else {
      // put options as dictionary at end of args
      if (options) {
        args = (args || []);
        args.push(makeObjectLiteral(options));
      }
    }

    return args;
  };

  var codeGenComponent = function (path, args, funcInfo,
                                   compOptions, isBlock) {

    var nameCode = codeGenPath(path, funcInfo);
    var argCode = (args.length || compOptions) ?
          codeGenArgs(args, funcInfo, compOptions || {}) : null;

    // XXX provide a better error message if
    // `foo` in `{{> foo}}` is not found?

    var comp = nameCode;

    if (path.length === 1) {
      comp = '(Template[' + toJSLiteral(path[0]) + '] || ' + comp + ')';
      // XXX MESSAY HACK FOR LEXICAL SCOPE OF CONTENT / ELSECONTENT.
      // Check for presence of local variables defined at top level of
      // of template decl, through `preamble` option to `Spacebars.compile`,
      // passed from `html_scanner`.
      if (path[0] === 'content' || path[0] === 'elseContent') {
        comp = '(typeof _local_' + path[0] + ' !== "undefined" ? _local_' +
          path[0] + ' : ' + comp + ')';
      }
    }

    // XXX For now, handle the calling convention for `{{> foo}}` and `{{#foo}`
    // using a wrapper component, which processes the arguments based
    // on the type of tag and the type of `foo` (component or function).
    // If `foo` changes reactively, the wrapper component is invalidated.
    //
    // This should be cleaned up to make the generated code cleaner and
    // to not have all the extra components and DomRanges hurting
    // peformance and showing up during debugging.
    return 'Spacebars.component("' + (isBlock ? '#' : '>') + '", ' + comp +
      (argCode ? ', [' + argCode.join(', ') + ']' : '') + ')';
//    return '{kind: UI.DynamicComponent, props: {' +
//      (isBlock? 'isBlock: true, ' : '') + 'compKind: ' + comp +
//      (argCode ? ', compArgs: [' + argCode.join(', ') + ']': '') + '}}';
  };

  var codeGenBasicStache = function (tag, funcInfo) {
    var nameCode = codeGenPath(tag.path, funcInfo);
    var argCode = codeGenArgs(tag.args, funcInfo);

    return 'Spacebars.mustache(' + nameCode +
      (argCode ? ', ' + argCode.join(', ') : '') + ')';
  };

  // Return the source code of a string or (reactive) function
  // (if necessary).
  var interpolate = function (strOrArray, funcInfo, interpolateMode) {
    if (typeof strOrArray === "string")
      return toJSLiteral(strOrArray);

    var parts = [];
    var isReactive = false;
    _.each(strOrArray, function (strOrTag) {
      if (typeof strOrTag === "string") {
        parts.push(toJSLiteral(strOrTag));
      } else {
        var tag = strOrTag;
        switch (tag.type) {
        case 'COMMENT':
          // nothing to do
          break;
        case 'DOUBLE': // fall through
        case 'TRIPLE':
          isReactive = true;
          if (interpolateMode === INTERPOLATE_ATTR_VALUE &&
              tag.type === 'TRIPLE')
            error("Can't have a triple-stache in an attribute value");
          parts.push(codeGenBasicStache(tag, funcInfo));
          break;
        default:
          // the parser would have errored on any components
          // inside an HTML tag, so no other stache tag
          // types possible.
          error("Unknown stache tag type: " + tag.type);
        }
      }
    });

//    if (isReactive) {
//      return 'function () { return ' + parts.join('+') +
//        '; }';
//    } else {
      return parts.length ? parts.join('+') : '""';
//    }
  };

  var tokensToRenderFunc = function (tokens, indent, isTopLevel) {
    var oldIndent = indent || '';
    indent = oldIndent + '  ';

    var funcInfo = {
      indent: indent, // read-only
      usedSelf: false // read/write
    };

    var renderables = [];

    var lastString = -1;
    var renderableString = function (str) {
      var escaped = toJSLiteral(str);

      var N = renderables.length;
      if (N && lastString === N - 1) {
        renderables[N - 1] = renderables[N - 1].slice(0, -1) +
          escaped.slice(1);
      } else {
        lastString = N;
        renderables.push(escaped);
      }
    };

    _.each(tokens, function (t) {
      switch (t.type) {
      case 'Characters':
        if (typeof t.data === 'string') {
          renderableString(
            UI.encodeSpecialEntities(t.data));
        } else {
          _.each(t.data, function (tagOrStr) {
            if (typeof tagOrStr === 'string') {
              renderableString(
                UI.encodeSpecialEntities(tagOrStr));
            } else {
              // tag or block
              var tag = tagOrStr;
              if (tag.isBlock) {
                // XXX as an optimization, move these inner
                // Component classes out so they become
                // members of the enclosing class, so they
                // aren't created per call to render.
                var block = tag;
                var extraArgs = {
                  __content: 'UI.Component.extend({render: ' +
                    tokensToRenderFunc(block.bodyTokens, indent + '  ') +
                    '})'
                };
                if (block.elseTokens) {
                  extraArgs.__elseContent =
                    'UI.Component.extend({render: ' +
                    tokensToRenderFunc(block.elseTokens, indent + '  ') +
                    '})';
                }
                renderables.push(codeGenComponent(
                  block.openTag.path,
                  block.openTag.args,
                  funcInfo, extraArgs, true));
              } else {
                switch (tag.type) {
                case 'INCLUSION':
                  renderables.push(codeGenComponent(
                    tag.path, tag.args, funcInfo));
                  break;
                case 'DOUBLE':
                case 'TRIPLE':
                  renderables.push(
                    'UI.' + (tag.type === 'TRIPLE' ? 'HTML' : 'Text') +
                      '.withData(function () {\n' + indent + '    return ' +
                      codeGenBasicStache(tag, funcInfo) +
                      ';\n' + indent + '  })');
                  break;
                case 'COMMENT':
                  break;
                default:
                  error("Unexpected tag type: " + tag.type);
                }
              }
            }
          });
        }
        break;
      case 'StartTag':
        // no space between tag name and attrs obj required
        renderableString("<" + t.name);

        if (t.data && t.data.length) {
          var isReactive = false;
          var attrs = {};
          var pairsWithReactiveNames = [];
          _.each(t.data, function (kv) {
            var name = kv.nodeName;
            var value = kv.nodeValue;
            if ((typeof name) === 'string') {
              // attribute name has no tags
              attrs = (attrs || {});
              attrs[toJSLiteral(name)] =
                interpolate(value, funcInfo,
                            INTERPOLATE_ATTR_VALUE);
              if ((typeof value) !== 'string')
                isReactive = true;
            } else if (value === '' &&
                       name.length === 1 &&
                       name[0].type === 'TRIPLE') {
              throw new Error("Triple-stache for attributes is no longer supported.  See https://github.com/meteor/meteor/commit/84b123e");
              // attribute name is a triple-stache, no value, as in:
              // `<div {{{attrs}}}>`.
              renderables.push(
                '{attrs: function () { return Spacebars.parseAttrs(' +
                  codeGenBasicStache(name[0], funcInfo) + '); }}');
            } else {
              pairsWithReactiveNames.push(
                interpolate(name, funcInfo,
                            INTERPOLATE_ATTR_VALUE),
                interpolate(value, funcInfo,
                            INTERPOLATE_ATTR_VALUE));
              isReactive = true;
            }
          });
          var attrCode = makeObjectLiteral(attrs);
          if (pairsWithReactiveNames.length) {
            attrCode = 'Spacebars.extend(' + attrCode +
              ', ' + pairsWithReactiveNames.join(', ') + ')';
          }
          if (isReactive)
            attrCode = ('function () { return ' + attrCode +
                        '; }');
          renderables.push('{attrs: ' + attrCode + '}');
        }

        renderableString(
          t.self_closing ? '/>' : '>');
        break;
      case 'EndTag':
        renderableString('</' + t.name + '>');
        break;
      case 'Comment':
        // XXX make comments reactive?  no clear use case.
        // here we allow double and triple stache and
        // only run it once.
        renderableString('<!--');
        renderables.push('Spacebars.escapeHtmlComment(' +
                         interpolate(t.name, funcInfo,
                                     INTERPOLATE_COMMENT) +
                         ')');
        renderableString('-->');
        break;
      case 'DocType':
        // XXX output a proper doctype based on
        // t.name, t.correct, t.publicId, t.systemId
        break;
      default:
        error("Unexpected token type: " + t.type);
        break;
      }
    });

    var preamble = (isTopLevel && options && options.preamble) || '';

    return 'function (buf) {' + preamble +
      (renderables.length ?
       (funcInfo.usedSelf ?
        '\n' + indent + 'var self = this;' : '') +
       '\n' + indent + 'buf.write(' +
       renderables.join(',\n' + indent + '  ') + ');\n' +
       oldIndent : '') + '}';
  };

  return tokensToRenderFunc(tree.bodyTokens, '', true);
};

// `Spacebars.index(foo, "bar", "baz")` performs a special kind
// of `foo.bar.baz` that allows safe indexing of `null` and
// indexing of functions to get other functions.
//
// In `Spacebars.index(foo, "bar")`, `foo` is assumed to be either
// a non-function value or a "fully-bound" function wrapping a value,
// taking no arguments and ignoring `this`.
//
// `Spacebars.index(foo, "bar")` behaves as follows:
//
// * If `foo` is falsy, `foo` is returned.
//
// * If either `foo` is a function or `foo.bar` is, then a new
// function is returned that, when called on arguments `args...`,
// calculates a "safe" version of `foo().bar(args...)`,
// where "dot" on a falsy value just returns the falsy value,
// and function calls are a no-op on non-functions.
//
// * Otherwise, the non-function `foo.bar` is returned.
Spacebars.index = function (value, id1/*, id2, ...*/) {
  if (arguments.length > 2) {
    // Note: doing this recursively is probably less efficient than
    // doing it in an iterative loop.
    var argsForRecurse = [];
    argsForRecurse.push(Spacebars.index(value, id1));
    argsForRecurse.push.apply(argsForRecurse,
                              Array.prototype.slice.call(arguments, 2));
    return Spacebars.index.apply(null, argsForRecurse);
  }

  if (! value)
    return value; // falsy, don't index, pass through

  if (typeof value !== 'function') {
    var result = value[id1];
    if (typeof result !== 'function')
      // neither `value` nor `value[id1]` are functions
      return result;
    // `value[id1]` is a function.  bind it so that when called, `value`
    // will be placed in `this`.
    return function (/*arguments*/) {
      return result.apply(value, arguments);
    };
  }

  // `value` is a function.
  return function (/*arguments*/) {
    var foo = value();
    if (! foo)
      // `value()[id1]` is falsy
      return foo; // falsy, don't index, pass through
    var bar = foo[id1];
    if (typeof bar !== 'function')
      // `value()[id1]` is a non-function
      return bar;
    // call `value()[id1](...arguments...)`
    return bar.apply(foo, arguments);
  };
};

// Like `Spacebars.index`, but does not defer calling a function when
// indexing it.  In other words, in `Spacebars.dot(foo, "bar")`, if
// `foo` is a function, it is called immediately, and the result is
// a function if `foo().bar` is a function and not if it is not.
//
// (In contrast, `Spacebars.index` will always return a reactive
// function if `foo` is a function, since it merely composes reactive
// computations without running them.)
Spacebars.dot = function (value, id1/*, id2, ...*/) {
  if (arguments.length > 2) {
    // Note: doing this recursively is probably less efficient than
    // doing it in an iterative loop.
    var argsForRecurse = [];
    argsForRecurse.push(Spacebars.dot(value, id1));
    argsForRecurse.push.apply(argsForRecurse,
                              Array.prototype.slice.call(arguments, 2));
    return Spacebars.dot.apply(null, argsForRecurse);
  }

  if (typeof value === 'function')
    value = value();

  if (! value)
    return value; // falsy, don't index, pass through

  var result = value[id1];
  if (typeof result !== 'function')
    // neither `value` nor `value[id1]` are functions
    return result;
  // `value[id1]` is a function.  bind it so that when called, `value`
  // will be placed in `this`.
  return function (/*arguments*/) {
    return result.apply(value, arguments);
  };
};

Spacebars.call = function (value/*, args*/) {
  if (typeof value !== 'function')
    return value; // ignore args

  var args = Array.prototype.slice.call(arguments, 1);

  // There is a correct value of `this` for any given
  // call, but we don't know it here.  It must be
  // bound to the function in advance (so that `value`
  // is actually a wrapper which ignores its `this`
  // and supplies one).
  return value.apply(null, args);
};

// Executes `{{foo bar baz}}` when called on `(foo, bar, baz)`.
// If `bar` and `baz` are functions, they are called.  `foo`
// may be a non-function, in which case the arguments are
// discarded (though they may still be evaluated, i.e. called).
Spacebars.mustache = function (value/*, args*/) {
  // call any arg that is a function (checked in Spacebars.call)
  for (var i = 1; i < arguments.length; i++)
    arguments[i] = Spacebars.call(arguments[i]);

  var result = Spacebars.call.apply(null, arguments);

  if (result instanceof Handlebars.SafeString)
    // keep as type Handlebars.SafeString since the UI.Text
    // component treats these differently.
    return result;
  else
    // map `null` and `undefined` to "", stringify anything else
    // (e.g. strings, booleans, numbers including 0).
    return String(result == null ? '' : result);
};

Spacebars.extend = function (obj/*, k1, v1, k2, v2, ...*/) {
  for (var i = 1; i < arguments.length; i += 2)
    obj[arguments[i]] = arguments[i+1];
  return obj;
};

Spacebars.parseAttrs = function (attrs) {
  if (! attrs) {
    return {};
  } else if (typeof attrs === 'object') {
    return attrs;
  } else {
    // XXX test this
    var tokens = HTML5Tokenizer.tokenize(
      '<x ' + attrs + ' >');
    var dict = {};
    if (tokens.length &&
        tokens[0].type === 'StartTag') {
      _.each(tokens[0].data, function (kv) {
        if (UI.isValidAttributeName(kv.nodeName))
          dict[kv.nodeName] = kv.nodeValue;
      });
    }
    return dict;
  }
};

Spacebars.escapeHtmlComment = function (str) {
  // comments can't have "--" in them in HTML.
  // just strip those so that we don't run into trouble.
  if ((typeof str) === 'string')
    return str.replace(/--/g, '');
  return str;
};

// XXX we want to get rid of UI.DynamicComponent.  See the code that
// emits calls to this function.
Spacebars.component = function (hashOrGreaterThan, kind, args) {
  return { kind: UI.DynamicComponent,
           props: { isBlock: (hashOrGreaterThan === '#'),
                    compKind: kind,
                    compArgs: args } };
};

//////////////////////////////////////////////////

Spacebars.parse2 = function (input) {
  // This implementation of `getSpecialTag` looks for "{{" and if it
  // finds it, it will parse a stache tag or fail fatally trying.
  // The object it returns is opaque to the tokenizer/parser and can
  // be anything we want.
  //
  // Parsing a block tag parses its contents and end tag too!
  var getSpecialTag = function (scanner, position) {
    if (! (scanner.peek() === '{' && // one-char peek is just an optimization
           scanner.rest().slice(0, 2) === '{{'))
      return null;

    // `parseStacheTag` will succeed or die trying.
    //
    // TODO: make `parseStacheTag` use the same `scanner`, and `scanner.fatal`
    // for errors, which should be made to still have nice line numbers.
    var stache = Spacebars.parseStacheTag(scanner.input, scanner.pos);
    // kill any `args: []` cluttering up the object
    if (stache.args && ! stache.args.length)
      delete stache.args;

    if (stache.type === 'ELSE')
      scanner.fatal("Found unexpected {{else}}}");
    else if (stache.type === 'BLOCKCLOSE')
      scanner.fatal("Found unexpected closing stache tag");

    scanner.pos += stache.charLength;
    // TODO: Change `parseStacheTag` to not generate these
    delete stache.charLength;
    delete stache.charPos;

    if (stache.type === 'COMMENT') {
      return null; // consume the tag from the input but emit no Special
    } else if (stache.type === 'BLOCKOPEN') {
      var blockName = stache.path.join(','); // for comparisons, errors

      stache.content = HTML.parseFragment(scanner, {
        getSpecialTag: getSpecialTag,
        shouldStop: isAtBlockCloseOrElse });

      if (scanner.rest().slice(0, 2) !== '{{')
        scanner.fatal("Expected {{else}} or block close for " + blockName);

      var stache2 = Spacebars.parseStacheTag(scanner.input, scanner.pos);

      if (stache2.type === 'ELSE') {
        scanner.pos += stache2.charLength;
        stache.elseContent = HTML.parseFragment(scanner, {
          getSpecialTag: getSpecialTag,
          shouldStop: isAtBlockCloseOrElse });

        if (scanner.rest().slice(0, 2) !== '{{')
          scanner.fatal("Expected block close for " + blockName);

        stache2 = Spacebars.parseStacheTag(scanner.input, scanner.pos);
      }

      if (stache2.type === 'BLOCKCLOSE') {
        var blockName2 = stache2.path.join(',');
        if (blockName !== blockName2)
          scanner.fatal('Expected tag to close ' + blockName + ', found ' +
                        + blockName2);
        scanner.pos += stache2.charLength;
      } else {
        scanner.fatal('Expected tag to close ' + blockName + ', found ' +
                      stache2.type);
      }
    }

    return stache;
  };

  var isAtBlockCloseOrElse = function (scanner) {
    // we could just call parseStacheTag, but this function is called
    // for every token in the input stream, so we add some shortcuts.
    var rest, type;
    return (scanner.peek() === '{' &&
            (rest = scanner.rest()).slice(0, 2) === '{{' &&
            /^\{\{\s*(\/|else\b)/.test(rest) &&
            (type = Spacebars.parseStacheTag(scanner.input,
                                             scanner.pos).type) &&
            (type === 'BLOCKCLOSE' || type === 'ELSE'));
  };

  var tree = HTML.parseFragment(input, { getSpecialTag: getSpecialTag });

  return tree;
};

var optimize = function (tree) {

  var pushRawHTML = function (array, html) {
    var N = array.length;
    if (N > 0 && array[N-1].tagName === 'Raw') {
      array[N-1][0] += html;
    } else {
      array.push(HTML.Raw(html));
    }
  };

  var isPureChars = function (html) {
    return (html.indexOf('&') < 0 && html.indexOf('<') < 0);
  };

  var optimizeArrayParts = function (array, optimizePartsFunc, forceOptimize) {
    var result = null;
    if (forceOptimize)
      result = [];
    for (var i = 0, N = array.length; i < N; i++) {
      var part = optimizePartsFunc(array[i]);
      if (part !== null) {
        // something special found
        if (result === null) {
          // This is our first special item.  Stringify the other parts.
          result = [];
          for (var j = 0; j < i; j++)
            pushRawHTML(result, UI.toHTML(array[j]));
        }
        result.push(part);
      } else {
        // just plain HTML found
        if (result !== null) {
          // we've already found something special, so convert this to Raw
          pushRawHTML(result, UI.toHTML(array[i]));
        }
      }
    }
    if (result !== null) {
      // clean up unnecessary HTML.Raw wrappers around pure character data
      for (var j = 0; j < result.length; j++) {
        if (result[j].tagName === 'Raw' &&
            isPureChars(result[j][0]))
          // replace HTML.Raw with simple string
          result[j] = result[j][0];
      }
    }
    return result;
  };

  var doesAttributeValueHaveSpecials = function (v) {
    var type = HTML.typeOf(v);
    if (type === 'null' || type === 'string' || type === 'charref') {
      return false;
    } else if (type === 'special') {
      return true;
    } else if (type === 'array') {
      for (var i = 0; i < v.length; i++)
        if (doesAttributeValueHaveSpecials(v[i]))
          return true;
      return false;
    } else {
      throw new Error("Unexpected node in attribute value: " + v);
    }
  };

  var optimizeParts = function (node) {
    // If we have nothing special going on, returns `null` (so that the
    // parent can optimize).  Otherwise returns a replacement for `node`
    // with optimized parts.
    if (UI.isComponent(node)) {
      return node;
    } else {
      var type = HTML.typeOf(node);
      if (type === 'special' || type === 'function' || type === 'emitcode') {
        // return node, which is special and thus already optimized as
        // much as possible
        return node;
      } else if (type === 'tag') {
        var mustOptimize = false;

        if (node.attrs) {
          var attrs = node.attrs;
          if (typeof attrs === 'function') {
            mustOptimize = true;
          } else {
            for (var k in attrs) {
              if (doesAttributeValueHaveSpecials(attrs[k])) {
                mustOptimize = true;
                break;
              }
            }
          }
        }

        var newChildren = optimizeArrayParts(node, optimizeParts, mustOptimize);

        if (newChildren === null)
          return null;

        var newTag = HTML.getTag(node.tagName).apply(null, newChildren);
        newTag.attrs = node.attrs;

        return newTag;
      } else if (type === 'array') {
        return optimizeArrayParts(node, optimizeParts);
      } else if (type === 'charref' || type === 'comment' || type === 'string' ||
                 type === 'null') {
        // not special; let parent decide how whether to optimize
        return null;
      } else {
        // can't get here
        throw new Error("Unexpected type: " + type);
      }
    };
  };

  var optTree = optimizeParts(tree);
  if (optTree !== null)
    // tree was optimized in parts
    return optTree;

  optTree = HTML.Raw(UI.toHTML(tree));

  if (isPureChars(optTree[0]))
    return optTree[0];

  return optTree;
};

var builtInComponents = {
  'content': '__content',
  'elseContent': '__elseContent',
  'if': 'UI.If2',
  'unless': 'UI.Unless2',
  'with': 'UI.With2'
};

var replaceSpecials = function (node) {
  if (UI.isComponent(node)) {
    return node;
  } else {
    var type = HTML.typeOf(node);
    if (type === 'tag') {
      // potential optimization: don't always create a new tag
      var newChildren = _.map(Array.prototype.slice.call(node), replaceSpecials);
      var newTag = HTML.getTag(node.tagName).apply(null, newChildren);
      newTag.attrs = Spacebars._handleSpecialAttributes(node.attrs);
      return newTag;
    } else if (type === 'array') {
      return _.map(node, replaceSpecials);
    } else if (type === 'special') {
      var tag = node.attrs;
      // XXX make sure we only pass a string through from the helper to the
      // Render API, except in the case of DOUBLE with a SafeString-like
      // situation.  Support our equivalent of SafeString.
      if (tag.type === 'DOUBLE') {
        return HTML.EmitCode('function () { return ' +
                             codeGenMustache(tag) + '; }');
      } else if (tag.type === 'TRIPLE') {
        var nameCode = codeGenPath2(tag.path);
        var argCode = codeGenArgs2(tag.args);

        return HTML.EmitCode('function () { return HTML.Raw(' +
                             codeGenMustache(tag) + '); }');
      } else if (tag.type === 'INCLUSION' || tag.type === 'BLOCKOPEN') {
        // XXX handle more stuff
        var path = tag.path;
        var compCode = codeGenPath2(path);

        if (path.length === 1) {
          var compName = path[0];
          if (builtInComponents.hasOwnProperty(compName)) {
            compCode = builtInComponents[compName];
          } else {
            compCode = ('(Template[' + toJSLiteral(path[0]) +
                        '] || ' + compCode + ')');
          }
        }

        var includeArgs = codeGenInclusionArgs(tag);

        return HTML.EmitCode(
          'function () { return Spacebars.include(' + compCode +
            (includeArgs.length ? ', ' + includeArgs.join(', ') : '') +
            '); }');
      } else {
        throw new Error("Unexpected template tag type: " + tag.type);
      }
    } else {
      return node;
    }
  };
};

var codeGenInclusionArgs = function (tag) {
  var args = null;
  var posArgs = [];

  if ('content' in tag) {
    args = (args || {});
    args.__content = (
      'UI.block(' + Spacebars.compile2(tag.content) + ')');
  }
  if ('elseContent' in tag) {
    args = (args || {});
    args.__elseContent = (
      'UI.block(' + Spacebars.compile2(tag.elseContent) + ')');
  }

  _.each(tag.args, function (arg) {
    var argType = arg[0];
    var argValue = arg[1];

    var isKeyword = (arg.length > 2);

    var argCode;
    switch (argType) {
    case 'STRING':
    case 'NUMBER':
    case 'BOOLEAN':
    case 'NULL':
      argCode = toJSLiteral(argValue);
      break;
    case 'PATH':
      var path = argValue;
      argCode = codeGenPath2(path);
      // a single-segment path will compile to something like
      // `self.lookup("foo")` which never establishes any dependencies,
      // while `Spacebars.dot(self.lookup("foo"), "bar")` may establish
      // dependencies.
      //
      // In the multi-positional-arg construct, no point wrapping
      // pos args after the first in a closure, as we have to
      // rerun the whole thing anyway if one changes.
      if (! ((path.length === 1) ||
             ((! isKeyword) && posArgs.length)))
        argCode = 'function () { return ' + argCode + '; }';
      break;
    default:
      // can't get here
      throw new Error("Unexpected arg type: " + argType);
    }

    if (isKeyword) {
      // keyword argument (represented as [type, value, name])
      var name = arg[2];
      args = (args || {});
      args[toJSLiteral(name)] = argCode;
    } else {
      // positional argument
      posArgs.push(argCode);
    }
  });

  if (posArgs.length === 1) {
    args = (args || {});
    args.data = posArgs[0];
  } else if (posArgs.length > 1) {
    // only allowed for block helper (which has already been
    // checked at parse time); call first
    // argument as a function on the others
    args = (args || {});
    args.data = 'function () { return Spacebars.call2(' + posArgs.join(', ') + '); }';
  }

  if (args)
    return [makeObjectLiteral(args)];

  return [];
};

Spacebars.include = function (kindOrFunc, args) {
  args = args || {};
  if (typeof kindOrFunc === 'function') {
    // function block helper
    var func = kindOrFunc;

    var hash = {};
    for (var k in args) {
      if (k !== 'data') {
        var v = args[k];
        hash[k] = (typeof v === 'function' ? v() : v);
      }
    }

    var result;
    if ('data' in args) {
      var data = args.data;
      data = (typeof data === 'function' ? data() : data);
      result = func(data, { hash: hash });
    } else {
      result = func({ hash: hash });
    }
    // In `{{#foo}}...{{/foo}}`, if `foo` is a function that
    // returns a component, attach __content and __elseContent
    // to it.
    if (UI.isComponent(result) &&
        (('__content' in args) || ('__elseContent' in args))) {
      var extra = {};
      if ('__content' in args)
        extra.__content = args.__content;
      if ('__elseContent' in args)
        extra.__elseContent = args.__elseContent;
      result = result.extend(extra);
    }
    return result;
  } else {
    // Component
    var kind = kindOrFunc;
    if (! UI.isComponent(kind))
      throw new Error("Expected template, found: " + kind);

    if (args) {
      var emboxedArgs = {};
      for (var k in args)
        emboxedArgs[k] = UI.emboxValue(args[k]);

      return kind.extend(emboxedArgs);
    } else {
      return kind;
    }
  }
};

// Input: Attribute dictionary, or null.  Attribute values may have `Special`
// nodes representing template tags.  In addition, the synthetic attribute
// `$specials` may be present and contain an array of `Special` nodes
// representing template tags in the attribute name position (i.e. "dynamic
// attributes" like `<div {{attrs}}>`).
//
// Output: If there are no Specials in the attribute values and no $specials,
// returns the input.  Otherwise, returns an object of the form `{$attrs:
// EmitCode("function () { return ... }")}`, which when converted to code
// will create code like `DIV({$attrs: function () { ... }}, ...)`.  The
// special key `$attrs` is interpreted at node construction time and causes
// the DIV node to have a function as its `.attrs`.
//
// (exposed for testing)
Spacebars._handleSpecialAttributes = function (oldAttrs) {
  if (! oldAttrs)
    return oldAttrs;

  // array of Special nodes wrapping template tags
  var dynamics = null;
  if (oldAttrs.$specials && oldAttrs.$specials.length)
    dynamics = oldAttrs.$specials;

  var foundSpecials = false;

  // Runs on an attribute value, or part of an attribute value.
  // If Specials are found, converts them to EmitCode with
  // the appropriate generated code.  Otherwise, returns the
  // input.
  //
  // If specials are found, sets `foundSpecials` to true.
  var convertSpecialToEmitCode = function (v) {
    var type = HTML.typeOf(v);
    if (type === 'null' || type === 'string' || type === 'charref') {
      return v;
    } else if (type === 'special') {
      foundSpecials = true;
      return HTML.EmitCode(codeGenMustache(v.attrs));
    } else if (type === 'array') {
      return _.map(v, convertSpecialToEmitCode);
    } else {
      throw new Error("Unexpected node in attribute value: " + v);
    }
  };

  var newAttrs = null;
  _.each(oldAttrs, function (value, name) {
    if (name.charAt(0) !== '$') {
      if (! newAttrs)
        newAttrs = {};
      newAttrs[name] = convertSpecialToEmitCode(value);
    }
  });

  if ((! dynamics) && (! foundSpecials))
    return oldAttrs;

  // strings of JS code evaluating to attribute dictionaries
  var attrObjectStrings = [];
  if (newAttrs)
    attrObjectStrings.push(UI.attributesToCode(newAttrs));
  if (dynamics) {
    _.each(dynamics, function (special) {
      var tag = special.attrs;
      attrObjectStrings.push(codeGenMustache(tag, 'attrMustache'));
    });
  }

  var finalAttrObjectString;
  if (attrObjectStrings.length > 1) {
    finalAttrObjectString =
      'Spacebars.combineAttributes(' + attrObjectStrings.join(', ') + ')';
  } else {
    finalAttrObjectString = attrObjectStrings[0];
  }

  return { $attrs: HTML.EmitCode("function () { return " +
                                 finalAttrObjectString +
                                 "; }") };
};

// Takes zero or more dictionaries as arguments.  Returns a new object created
// by starting with an empty object and copying the attributes from each
// argument object, from left to right, with later attributes taking precedence
// if two objects have attributes of the same name.
Spacebars.combineAttributes = function (/*attrObjects*/) {
  // Use _.extend({}, arg1, arg2, arg3, ...)
  var args = [{}];
  args.push.apply(args, arguments);
  return _.extend.apply(_, args);
};

// Executes `{{foo bar baz}}` when called on `(foo, bar, baz)`.
// If `bar` and `baz` are functions, they are called before
// `foo` is called on them.
Spacebars.mustache2 = function (value/*, args*/) {
  var result = Spacebars.call2.apply(null, arguments);

  if (result instanceof Handlebars.SafeString)
    // keep as type Handlebars.SafeString since the UI.Text
    // component treats these differently.
    return result;
  else
    // map `null` and `undefined` to "", stringify anything else
    // (e.g. strings, booleans, numbers including 0).
    return String(result == null ? '' : result);
};

// If `value` is a function, called it on the `args`, after
// evaluating the args themselves (by calling them if they are
// functions).  Otherwise, simply return `value` (and assert that
// there are no args).
Spacebars.call2 = function (value/*, args*/) {
  if (typeof value === 'function') {
    // evaluate arguments if they are functions (by calling them)
    var newArgs = [];
    for (var i = 1; i < arguments.length; i++) {
      var arg = arguments[i];
      newArgs[i-1] = (typeof arg === 'function' ? arg() : arg);
    }

    return value.apply(null, newArgs);
  } else {
    if (arguments.length > 1)
      throw new Error("Can't call non-function: " + value);

    return value;
  }
};

Spacebars.attrMustache = function (value/*, args*/) {

  var result = Spacebars.call2.apply(null, arguments);

  if (result == null || result === '') {
    return null;
  } else if (typeof result === 'object') {
    return result;
  } else if (typeof result === 'string' && UI.isValidAttributeName(result)) {
    var obj = {};
    obj[result] = '';
    return obj;
  } else {
    throw new Error("Expected valid attribute name, '', null, or object");
  }
};

var codeGenMustache = function (tag, mustacheType) {
  var nameCode = codeGenPath2(tag.path);
  var argCode = codeGenArgs2(tag.args);
  var mustache = (mustacheType || 'mustache2');

  return 'Spacebars.' + mustache + '(' + nameCode +
    (argCode ? ', ' + argCode.join(', ') : '') + ')';
};

Spacebars.compile2 = function (input, options) {
  var tree;

  // Accept string or output of Spacebars.parse
  if (typeof input === 'string')
    tree = Spacebars.parse2(input);
  else
    tree = input;

  tree = optimize(tree);

  tree = replaceSpecials(tree);

  // is this a template, rather than a block passed to
  // a block helper, say
  var isTemplate = (options && options.isTemplate);

  var code = '(function () { var self = this; ';
  if (isTemplate) {
    // support `{{> content}}` and `{{> elseContent}}` with
    // lexical scope by creating a local variable in the
    // template's render function.
    code += 'var __content = self.__content, ' +
      '__elseContent = self.__elseContent; ';
  }
  code += 'return ';
  code += UI.toCode(tree);
  code += '; })';

  code = beautify(code);

  return code;
};

var beautify = function (code) {
  if (Package.minifiers) {
    var result = UglifyJSMinify(code,
                                { fromString: true,
                                  mangle: false,
                                  compress: false,
                                  output: { beautify: true,
                                            indent_level: 2,
                                            width: 80 } });
    var output = result.code;
    // Uglify interprets our expression as a statement and may add a semicolon.
    // Strip trailing semicolon.
    output = output.replace(/;$/, '');
    return output;
  } else {
    // don't actually beautify; no UglifyJS
    return code;
  }
};

// expose for compiler output tests
Spacebars._beautify = beautify;

// `path` is an array of at least one string.
//
// If `path.length > 1`, the generated code may be reactive
// (i.e. it may invalidate the current computation).
//
// No code is generated to call the result if it's a function.
var codeGenPath2 = function (path) {
  var code = 'self.lookup(' + toJSLiteral(path[0]) + ')';

  if (path.length > 1) {
    code = 'Spacebars.dot(' + code + ', ' +
      _.map(path.slice(1), toJSLiteral).join(', ') + ')';
  }

  return code;
};

// returns: array of source strings, or null if no
// args at all.
var codeGenArgs2 = function (tagArgs) {
  var kwArgs = null; // source -> source
  var args = null; // [source]

  _.each(tagArgs, function (arg) {
    var argType = arg[0];
    var argValue = arg[1];

    var argCode;
    switch (argType) {
    case 'STRING':
    case 'NUMBER':
    case 'BOOLEAN':
    case 'NULL':
      argCode = toJSLiteral(argValue);
      break;
    case 'PATH':
      argCode = codeGenPath2(argValue);
      break;
    default:
      // can't get here
      throw new Error("Unexpected arg type: " + argType);
    }

    if (arg.length > 2) {
      // keyword argument (represented as [type, value, name])
      kwArgs = (kwArgs || {});
      kwArgs[toJSLiteral(arg[2])] = argCode;
    } else {
      // positional argument
      args = (args || []);
      args.push(argCode);
    }
  });

  // put kwArgs in options dictionary at end of args
  if (kwArgs) {
    args = (args || []);
    args.push('{hash: ' + makeObjectLiteral(kwArgs) + '}');
  }

  return args;
};
