var jb = (function() {
function jb_run(context,parentParam,settings) {
  try {
    var profile = context.profile;
    if (context.probe && (!settings || !settings.noprobe)) {
      if (context.probe.pathToTrace.indexOf(context.path) == 0)
        return context.probe.record(context,parentParam)
    }
    if (profile == null || (typeof profile == 'object' && profile.$disabled))
      return castToParam(null,parentParam);

    if (profile.$debugger == 0) debugger;
    if (profile.$asIs) return profile.$asIs;
    if (parentParam && (parentParam.type||'').indexOf('[]') > -1 && ! parentParam.as) // fix to array value. e.g. single feature not in array
        parentParam.as = 'array';

    if (typeof profile === 'object' && Object.getOwnPropertyNames(profile).length == 0)
      return;
    var contextWithVars = extendWithVars(context,profile.$vars);
    var run = prepare(contextWithVars,parentParam);
    var jstype = parentParam && parentParam.as;
    context.parentParam = parentParam;
    switch (run.type) {
      case 'booleanExp': return bool_expression(profile, context);
      case 'expression': return castToParam(expression(profile, context,parentParam), parentParam);
      case 'asIs': return profile;
      case 'object': return entriesToObject(entries(profile).map(e=>[e[0],contextWithVars.runInner(e[1],null,e[0])]));
      case 'function': return castToParam(profile(context),parentParam);
      case 'null': return castToParam(null,parentParam);
      case 'ignore': return context.data;
      case 'list': return profile.map((inner,i) =>
            contextWithVars.runInner(inner,null,i));
      case 'runActions': return jb.comps.runActions.impl(new jbCtx(contextWithVars,{profile: { actions : profile },path:''}));
      case 'if': {
          var cond = jb_run(run.ifContext, run.IfParentParam);
          if (cond && cond.then)
            return cond.then(res=>
              res ? jb_run(run.thenContext, run.thenParentParam) : jb_run(run.elseContext, run.elseParentParam))
          return cond ? jb_run(run.thenContext, run.thenParentParam) : jb_run(run.elseContext, run.elseParentParam);
      }
      case 'profile':
        if (!run.impl)
          run.ctx.callerPath = context.path;

        run.preparedParams.forEach(paramObj => {
          switch (paramObj.type) {
            case 'function': run.ctx.params[paramObj.name] = paramObj.outerFunc(run.ctx) ;  break;
            case 'array': run.ctx.params[paramObj.name] =
                paramObj.array.map((prof,i) =>
                  jb_run(new jbCtx(run.ctx,{profile: prof, forcePath: context.path + '~' + paramObj.path+ '~' + i, path: ''}), paramObj.param))
                  //run.ctx.runInner(prof, paramObj.param, paramObj.path+'~'+i) )
              ; break;  // maybe we should [].concat and handle nulls
            default: run.ctx.params[paramObj.name] =
              jb_run(new jbCtx(run.ctx,{profile: paramObj.prof, forcePath: context.path + '~' + paramObj.path, path: ''}), paramObj.param);
            //run.ctx.runInner(paramObj.prof, paramObj.param, paramObj.path)
            //jb_run(paramObj.context, paramObj.param);
          }
        });
        var out;
        if (run.impl) {
          var args = prepareGCArgs(run.ctx,run.preparedParams);
          if (profile.$debugger) debugger;
          if (! args.then)
            out = run.impl.apply(null,args);
          else
            return args.then(args=>
              castToParam(run.impl.apply(null,args),parentParam))
        }
        else {
          out = jb_run(new jbCtx(run.ctx, { componentContext: run.ctx }),parentParam);
        }

        if (profile.$log)
          console.log(contextWithVars.run(profile.$log));

        if (profile.$trace) console.log('trace: ' + context.path,context,out,run);

        return castToParam(out,parentParam);
    }
  } catch (e) {
    if (context.vars.$throw) throw e;
    logException(e,'exception while running run');
  }

  function prepareGCArgs(ctx,preparedParams) {
    var delayed = preparedParams.filter(param => {
      var v = ctx.params[param.name] || {};
      return (v.then || v.subscribe ) && param.param.as != 'observable'
    });
    if (delayed.length == 0 || typeof Observable == 'undefined')
      return [ctx].concat(preparedParams.map(param=>ctx.params[param.name]))

    return Observable.from(preparedParams)
        .concatMap(param=>
          ctx.params[param.name])
        .toArray()
        .map(x=>
          [ctx].concat(x))
        .toPromise()
  }
}

function extendWithVars(context,vars) {
  if (!vars) return context;
  var res = context;
  for(var varname in vars || {})
    res = new jbCtx(res,{ vars: jb.obj(varname,res.runInner(vars[varname], null,'$vars~'+varname)) });
  return res;
}

function compParams(comp) {
  if (!comp || !comp.params)
    return [];
  return Array.isArray(comp.params) ? comp.params : entries(comp.params).map(x=>extend(x[1],jb.obj('id',x[0])));
}

function prepareParams(comp,profile,ctx) {
  return compParams(comp)
    .filter(comp=>
      !comp.ignore)
    .map((param,index) => {
      var p = param.id;
      var val = profile[p], path =p, sugar = sugarProp(profile);
      if (!val && index == 0 && sugar) {
        path = sugar[0];
        val = sugar[1];
      }
      var valOrDefault = (typeof val != "undefined" && val != null) ? val : (typeof param.defaultValue != 'undefined' ? param.defaultValue : null);
      var valOrDefaultArray = valOrDefault ? valOrDefault : []; // can remain single, if null treated as empty array
      var arrayParam = param.type && param.type.indexOf('[]') > -1 && Array.isArray(valOrDefaultArray);

      if (param.dynamic) {
        var outerFunc = runCtx => {
          if (arrayParam)
            var func = (ctx2,data2) =>
              jb.flattenArray(valOrDefaultArray.map((prof,i)=>
                runCtx.extendVars(ctx2,data2).runInner(prof,param,path+'~'+i)))
          else
            var func = (ctx2,data2) =>
                  valOrDefault != null ? runCtx.extendVars(ctx2,data2).runInner(valOrDefault,param,path) : valOrDefault;

          Object.defineProperty(func, "name", { value: p }); // for debug
          func.profile = (typeof(val) != "undefined") ? val : (typeof(param.defaultValue) != 'undefined') ? param.defaultValue : null;
          func.srcPath = ctx.path;
          return func;
        }
        return { name: p, type: 'function', outerFunc: outerFunc, path: path, param: param };
      }

      if (arrayParam) // array of profiles
        return { name: p, type: 'array', array: valOrDefaultArray, param: Object.assign({},param,{type:param.type.split('[')[0],as:null}), path: path };
      else
        return { name: p, type: 'run', prof: valOrDefault, param: param, path: path }; // context: new jbCtx(ctx,{profile: valOrDefault, path: p}),
  })
}

function prepare(context,parentParam) {
  var profile = context.profile;
  var profile_jstype = typeof profile;
  var parentParam_type = parentParam && parentParam.type;
  var jstype = parentParam && parentParam.as;
  var isArray = Array.isArray(profile);

  if (profile_jstype === 'string' && parentParam_type === 'boolean') return { type: 'booleanExp' };
  if (profile_jstype === 'boolean' || profile_jstype === 'number' || parentParam_type == 'asIs') return { type: 'asIs' };// native primitives
  if (profile_jstype === 'object' && jstype === 'object') return { type: 'object' };
  if (profile_jstype === 'string') return { type: 'expression' };
  if (profile_jstype === 'function') return { type: 'function' };
//  if (profile_jstype === 'object' && !isArray && entries(profile).filter(p=>p[0].indexOf('$') == 0).length == 0) return { type: 'asIs' };
  if (profile_jstype === 'object' && (profile instanceof RegExp)) return { type: 'asIs' };
  if (profile == null) return { type: 'asIs' };

  if (isArray) {
    if (!profile.length) return { type: 'null' };
    if (!parentParam || !parentParam.type || parentParam.type === 'data' ) //  as default for array
      return { type: 'list' };
    if (parentParam_type === 'action' || parentParam_type === 'action[]' && profile.isArray) {
      profile.sugar = true;
      return { type: 'runActions' };
    }
  } else if (profile.$if)
  return {
      type: 'if',
      ifContext: new jbCtx(context,{profile: profile.$if || profile.condition, path: '$if'}),
      IfParentParam: { type: 'boolean', as:'boolean' },
      thenContext: new jbCtx(context,{profile: profile.then || 0 , path: '~then'}),
      thenParentParam: { type: parentParam_type, as:jstype },
      elseContext: new jbCtx(context,{profile: profile['else'] || 0 , path: '~else'}),
      elseParentParam: { type: parentParam_type, as:jstype }
    }
  var comp_name = compName(profile,parentParam);
  if (!comp_name)
    return { type: 'asIs' }
  // if (!comp_name)
  //   return { type: 'ignore' }
  var comp = jb.comps[comp_name];
  if (!comp && comp_name) { logError('component ' + comp_name + ' is not defined'); return { type:'null' } }
  if (!comp.impl) { logError('component ' + comp_name + ' has no implementation'); return { type:'null' } }

  var ctx = new jbCtx(context,{});
  ctx.parentParam = parentParam;
  ctx.params = {}; // TODO: try to delete this line
  var preparedParams = prepareParams(comp,profile,ctx);
  if (typeof comp.impl === 'function') {
    Object.defineProperty(comp.impl, "name", { value: comp_name }); // comp_name.replace(/[^a-zA-Z0-9]/g,'_')
    return { type: 'profile', impl: comp.impl, ctx: ctx, preparedParams: preparedParams }
  } else
    return { type:'profile', ctx: new jbCtx(ctx,{profile: comp.impl, comp: comp_name, path: ''}), preparedParams: preparedParams };
}

function resolveFinishedPromise(val) {
  if (!val) return val;
  if (val.$jb_parent)
    val.$jb_parent = resolveFinishedPromise(val.$jb_parent);
  if (val && typeof val == 'object' && val._state == 1) // finished promise
    return val._result;
  return val;
}

function calcVar(context,varname) {
  var res;
  if (context.componentContext && typeof context.componentContext.params[varname] != 'undefined')
    res = context.componentContext.params[varname];
  else if (context.vars[varname] != null)
    res = context.vars[varname];
  else if (context.vars.scope && context.vars.scope[varname] != null)
    res = context.vars.scope[varname];
  else if (jb.resources && jb.resources[varname] != null)
    res = jb.resources[varname];
  return resolveFinishedPromise(res);
}

function expression(exp, context, parentParam) {
  var jstype = parentParam && (parentParam.ref ? 'ref' : parentParam.as);
  exp = '' + exp;
  if (jstype == 'boolean') return bool_expression(exp, context);
  if (exp.indexOf('$debugger:') == 0) {
    debugger;
    exp = exp.split('$debugger:')[1];
  }
  if (exp.indexOf('$log:') == 0) {
    var out = expression(exp.split('$log:')[1],context,parentParam);
    jb.comps.log.impl(context, out);
    return out;
  }
  if (exp.indexOf('%') == -1 && exp.indexOf('{') == -1) return exp;
  // if (context && !context.ngMode)
  //   exp = exp.replace(/{{/g,'{%').replace(/}}/g,'%}')
  if (exp == '{%%}' || exp == '%%')
      return expPart('',context,jstype);

  if (exp.lastIndexOf('{%') == 0 && exp.indexOf('%}') == exp.length-2) // just one exp filling all string
    return expPart(exp.substring(2,exp.length-2),context,jstype);

  exp = exp.replace(/{%(.*?)%}/g, function(match,contents) {
      return tostring(expPart(contents,context,'string'));
  })
  exp = exp.replace(/{\?(.*?)\?}/g, function(match,contents) {
      return tostring(conditionalExp(contents));
  })
  if (exp.match(/^%[^%;{}\s><"']*%$/)) // must be after the {% replacer
    return expPart(exp.substring(1,exp.length-1),context,jstype);

  exp = exp.replace(/%([^%;{}\s><"']*)%/g, function(match,contents) {
      return tostring(expPart(contents,context,'string'));
  })
  return exp;

  function conditionalExp(exp) {
    // check variable value - if not empty return all exp, otherwise empty
    var match = exp.match(/%([^%;{}\s><"']*)%/);
    if (match && tostring(expPart(match[1],context,'string')))
      return expression(exp, context, { as: 'string' });
    else
      return '';
  }

  function expPart(expressionPart,context,jstype) {
    return resolveFinishedPromise(evalExpressionPart(expressionPart,context,jstype))
  }
}


function evalExpressionPart(expressionPart,context,jstype) {
  // example: %$person.name%.

  var primitiveJsType = ['string','boolean','number'].indexOf(jstype) != -1;
  // empty primitive expression - perfomance
  // if (expressionPart == "")
  //   return context.data;

  var parts = expressionPart.split(/[.\/]/);
  return parts.reduce((input,subExp,index)=>pipe(input,subExp,index == parts.length-1,index == 0),context.data)

  function pipe(input,subExp,last,first,refHandler) {
      if (subExp == '')
          return input;

      var arrayIndexMatch = subExp.match(/(.*)\[([0-9]+)\]/); // x[y]
      var refHandler = refHandler || (input && input.handler) || jb.valueByRefHandler;
      if (arrayIndexMatch) {
        var arr = arrayIndexMatch[1] == "" ? val(input) : pipe(val(input),arrayIndexMatch[1],false,first,refHandler);
        var index = arrayIndexMatch[2];
        if (!Array.isArray(arr))
            return null; //jb.logError('expecting array instead of ' + typeof arr, context);

        if (last && (jstype == 'ref' || !primitiveJsType))
           return refHandler.objectProperty(arr,index);
        if (typeof arr[index] == 'undefined')
           arr[index] = last ? null : [];
			  if (last && jstype)
           return jstypes[jstype](arr[index]);
        return arr[index];
     }

      var functionCallMatch = subExp.match(/=([a-zA-Z]*)\(?([^)]*)\)?/);
      if (functionCallMatch && jb.functions[functionCallMatch[1]])
        return tojstype(jb.functions[functionCallMatch[1]](context,functionCallMatch[2]),jstype,context);

      if (first && subExp.charAt(0) == '$' && subExp.length > 1)
        return calcVar(context,subExp.substr(1))
      var obj = val(input);
      if (subExp == 'length' && obj && typeof obj.length != 'undefined')
        return obj.length;
      if (Array.isArray(obj))
        return obj.map(item=>pipe(item,subExp,last,false,refHandler)).filter(x=>x!=null);

      if (input != null && typeof input == 'object') {
        if (obj == null) return;
        if (typeof obj[subExp] === 'function' && obj[subExp].profile)
            return obj[subExp](context);
        if (last && jstype == 'ref')
           return refHandler.objectProperty(obj,subExp);
        if (typeof obj[subExp] == 'undefined')
           obj[subExp] = last ? null : {};
        if (last && jstype)
            return jstypes[jstype](obj[subExp]);
        return obj[subExp];
      }
  }
}

function bool_expression(exp, context) {
  if (exp.indexOf('$debugger:') == 0) {
    debugger;
    exp = exp.split('$debugger:')[1];
  }
  if (exp.indexOf('$log:') == 0) {
    var calculated = expression(exp.split('$log:')[1],context,{as: 'string'});
    var result = bool_expression(exp.split('$log:')[1], context);
    jb.comps.log.impl(context, calculated + ':' + result);
    return result;
  }
  if (exp.indexOf('!') == 0)
    return !bool_expression(exp.substring(1), context);
  var parts = exp.match(/(.+)(==|!=|<|>|>=|<=|\^=|\$=)(.+)/);
  if (!parts) {
    var val = jb.val(expression(exp, context));
    if (typeof val == 'boolean') return val;
    var asString = tostring(val);
    return !!asString && asString != 'false';
  }
  if (parts.length != 4)
    return logError('invalid boolean expression: ' + exp);
  var op = parts[2].trim();

  if (op == '==' || op == '!=' || op == '$=' || op == '^=') {
    var p1 = tostring(expression(trim(parts[1]), context, {as: 'string'}))
    var p2 = tostring(expression(trim(parts[3]), context, {as: 'string'}))
    // var p1 = expression(trim(parts[1]), context, {as: 'string'});
    // var p2 = expression(trim(parts[3]), context, {as: 'string'});
    p2 = (p2.match(/^["'](.*)["']/) || [,p2])[1]; // remove quotes
    if (op == '==') return p1 == p2;
    if (op == '!=') return p1 != p2;
    if (op == '^=') return p1.lastIndexOf(p2,0) == 0; // more effecient
    if (op == '$=') return p1.indexOf(p2, p1.length - p2.length) !== -1;
  }

  var p1 = tonumber(expression(parts[1].trim(), context));
  var p2 = tonumber(expression(parts[3].trim(), context));

  if (op == '>') return p1 > p2;
  if (op == '<') return p1 < p2;
  if (op == '>=') return p1 >= p2;
  if (op == '<=') return p1 <= p2;

  function trim(str) {  // trims also " and '
    return str.trim().replace(/^"(.*)"$/,'$1').replace(/^'(.*)'$/,'$1');
  }
}

function castToParam(value,param) {
  var res = tojstype(value,param ? param.as : null);
  if (param && param.as == 'ref' && param.whenNotReffable && !jb.isRef(res))
    res = tojstype(value,param.whenNotReffable);
  return res;
}

function tojstype(value,jstype) {
  if (!jstype) return value;
  if (typeof jstypes[jstype] != 'function') debugger;
  return jstypes[jstype](value);
}

var tostring = value => tojstype(value,'string');
var toarray = value => tojstype(value,'array');
var toboolean = value => tojstype(value,'boolean');
var tosingle = value => tojstype(value,'single');
var tonumber = value => tojstype(value,'number');

var jstypes = {
    'asIs': x => x,
    'object': x => x,
    'string': function(value) {
      if (Array.isArray(value)) value = value[0];
      if (value == null) return '';
      value = val(value);
      if (typeof(value) == 'undefined') return '';
      return '' + value;
    },
    'number': function(value) {
      if (Array.isArray(value)) value = value[0];
      if (value == null || value == undefined) return null;	// 0 is not null
      value = val(value);
      var num = Number(value,true);
      return isNaN(num) ? null : num;
    },
    'array': function(value) {
      if (typeof value == 'function' && value.profile)
        value = value();
      value = val(value);
      if (Array.isArray(value)) return value;
      if (value == null) return [];
      return [value];
    },
    'boolean': function(value) {
      if (Array.isArray(value)) value = value[0];
      return val(value) ? true : false;
    },
    'single': function(value) {
      if (Array.isArray(value))
        value = value[0];
      return val(value);
    },
    'ref': function(value) {
//      if (Array.isArray(value)) value = value[0];
//      if (value == null) return value;
      if (Array.isArray(value) && value.length == 1)
        value = value[0];
      return jb.valueByRefHandler.asRef(value);
    }
}

function profileType(profile) {
  if (!profile) return '';
  if (typeof profile == 'string') return 'data';
  var comp_name = compName(profile);
  return (jb.comps[comp_name] && jb.comps[comp_name].type) || '';
}

function sugarProp(profile) {
  return entries(profile)
    .filter(p=>p[0].indexOf('$') == 0 && p[0].length > 1)
    .filter(p=>p[0].indexOf('$jb_') != 0)
    .filter(p=>['$vars','$debugger','$log'].indexOf(p[0]) == -1)[0]
}

function singleInType(profile,parentParam) {
  var _type = parentParam && parentParam.type && parentParam.type.split('[')[0];
  return _type && jb.comps[_type] && jb.comps[_type].singleInType && _type;
}

function compName(profile,parentParam) {
  if (!profile || Array.isArray(profile)) return;
  if (profile.$) return profile.$;
  var f = sugarProp(profile);
  return (f && f[0].slice(1)) || singleInType(profile,parentParam);
}

// give a name to the impl function. Used for tgp debugging
function assignNameToFunc(name, fn) {
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

var ctxCounter = 0;

class jbCtx {
  constructor(context,ctx2) {
    this.id = ctxCounter++;
    this._parent = context;
    if (typeof context == 'undefined') {
      this.vars = {};
      this.params = {};
    }
    else {
      if (ctx2.profile && ctx2.path == null) {
        debugger;
      ctx2.path = '?';
    }
      this.profile = (typeof(ctx2.profile) != 'undefined') ?  ctx2.profile : context.profile;

      this.path = (context.path || '') + (ctx2.path ? '~' + ctx2.path : '');
      if (ctx2.forcePath)
        this.path = this.forcePath = ctx2.forcePath;
      if (ctx2.comp)
        this.path = ctx2.comp + '~impl';
      this.data= (typeof ctx2.data != 'undefined') ? ctx2.data : context.data;     // allow setting of data:null
      this.vars= ctx2.vars ? Object.assign({},context.vars,ctx2.vars) : context.vars;
      this.params= ctx2.params || context.params;
      this.componentContext= (typeof ctx2.componentContext != 'undefined') ? ctx2.componentContext : context.componentContext;
      this.probe= context.probe;
    }
  }
  run(profile,parentParam) {
    return jb_run(new jbCtx(this,{ profile: profile, comp: profile.$ , path: ''}), parentParam)
  }
  exp(exp,jstype) { return expression(exp, this, {as: jstype}) }
  setVars(vars) { return new jbCtx(this,{vars: vars}) }
  setData(data) { return new jbCtx(this,{data: data}) }
  runInner(profile,parentParam, path) { return jb_run(new jbCtx(this,{profile: profile,path: path}), parentParam) }
  bool(profile) { return this.run(profile, { as: 'boolean'}) }
  // keeps the context vm and not the caller vm - needed in studio probe
  ctx(ctx2) { return new jbCtx(this,ctx2) }
  win() { // used for multi windows apps. e.g., studio
    return window
  }
  extendVars(ctx2,data2) {
    if (ctx2 == null && data2 == null)
      return this;
    return new jbCtx(this,{
      vars: ctx2 ? ctx2.vars : null,
      data: (data2 == null) ? ctx2.data : data2,
      forcePath: (ctx2 && ctx2.forcePath) ? ctx2.forcePath : null
    })
  }
  runItself(parentParam,settings) { return jb_run(this,parentParam,settings) }
  parents() {
    return this._parent ? [this._parent].concat(_this.parent.parents()) : []
  }
  isParentOf(childCtx) {
    return childCtx.parents().filter(x == this).length > 0
  }

}

var logs = {};
function logError(errorStr,p1,p2,p3) {
  logs.error = logs.error || [];
  logs.error.push(errorStr);
  console.error(errorStr,p1,p2,p3);
}

function logPerformance(type,p1,p2,p3) {
//  var types = ['focus','apply','check','suggestions','writeValue','render','probe','setState'];
  if ((jb.issuesTolog || []).indexOf(type) == -1) return; // filter. TBD take from somewhere else
  console.log(type, p1 || '', p2 || '', p3 ||'');
}

function logException(e,errorStr,p1,p2,p3) {
  logError('exception: ' + errorStr + "\n" + (e.stack||''),p1,p2,p3);
}

function val(v) {
  if (v == null) return v;
  return jb.valueByRefHandler.val(v)
}
// Object.getOwnPropertyNames does not keep the order !!!
function entries(obj) {
  if (!obj || typeof obj != 'object') return [];
  var ret = [];
  for(var i in obj) // please do not change. its keeps definition order !!!!
      if (obj.hasOwnProperty(i) && i.indexOf('$jb_') != 0)
        ret.push([i,obj[i]])
  return ret;
}
function extend(obj,obj1,obj2,obj3) {
  if (!obj) return;
  obj1 && Object.assign(obj,obj1);
  obj2 && Object.assign(obj,obj2);
  obj3 && Object.assign(obj,obj3);
  return obj;
}


// var valueByRefHandlerWithjbParent = {
//   val: function(v) {
//     if (v.$jb_val) return v.$jb_val();
//     return (v.$jb_parent) ? v.$jb_parent[v.$jb_property] : v;
//   },
//   writeValue: function(to,value,srcCtx) {
//     jb.logPerformance('writeValue',value,to,srcCtx);
//     if (!to) return;
//     if (to.$jb_val)
//       to.$jb_val(this.val(value))
//     else if (to.$jb_parent)
//       to.$jb_parent[to.$jb_property] = this.val(value);
//     return to;
//   },
//   asRef: function(value) {
//     if (value && (value.$jb_parent || value.$jb_val))
//         return value;
//     return { $jb_val: () => value }
//   },
//   isRef: function(value) {
//     return value && (value.$jb_parent || value.$jb_val);
//   },
//   objectProperty: function(obj,prop) {
//       if (this.isRef(obj[prop]))
//         return obj[prop];
//       else
//         return { $jb_parent: obj, $jb_property: prop };
//   }
// }
//
var valueByRefHandler = null; // valueByRefHandlerWithjbParent;

var types = {}, ui = {}, rx = {}, ctxDictionary = {}, testers = {};

return {
  jbCtx: jbCtx,

  run: jb_run,
  expression: expression,
  bool_expression: bool_expression,
  profileType: profileType,
  compName: compName,
  logError: logError,
  logPerformance: logPerformance,
  logException: logException,

  tojstype: tojstype, jstypes: jstypes,
  tostring: tostring, toarray:toarray, toboolean: toboolean,tosingle:tosingle,tonumber:tonumber,

  valueByRefHandler: valueByRefHandler,
  types: types,
  ui: ui,
  rx: rx,
  ctxDictionary: ctxDictionary,
  testers: testers,
  compParams: compParams,
  singleInType: singleInType,
  val: val,
  entries: entries,
  extend: extend,
  ctxCounter: _ => ctxCounter
}

})();

Object.assign(jb,{
  comps: {}, functions: {}, resources: {},
  studio: { previewjb: jb },
  component: (id,val) => jb.comps[id] = val,
  type: (id,val) => jb.types[id] = val || {},
  resource: (id,val) => typeof val == 'undefined' ? jb.resources[id] : (jb.resources[id] = val || {}),
  functionDef: (id,val) => jb.functions[id] = val,

// force path - create objects in the path if not exist
  path: (object,path,value) => {
    var cur = object;

    if (typeof value == 'undefined') {  // get
      for(var i=0;i<path.length;i++) {
        cur = cur[path[i]];
        if (cur == null || typeof cur == 'undefined') return null;
      }
      return cur;
    } else { // set
      for(var i=0;i<path.length;i++)
        if (i == path.length-1)
          cur[path[i]] = value;
        else
          cur = cur[path[i]] = cur[path[i]] || {};
      return value;
    }
  },
  ownPropertyNames: obj => {
    var res = [];
    for (var i in (obj || {}))
      if (obj.hasOwnProperty(i))
        res.push(i);
    return res;
  },
  obj: (k,v,base) => {
    var ret = base || {};
    ret[k] = v;
    return ret;
  },
  compareArrays: (arr1, arr2) => {
    if (arr1 == arr2)
      return true;
    if (!Array.isArray(arr1) && !Array.isArray(arr2)) return arr1 == arr2;
    if (!arr1 || !arr2 || arr1.length != arr2.length) return false;
    for (var i = 0; i < arr1.length; i++) {
      var key1 = (arr1[i]||{}).key, key2 = (arr2[i]||{}).key;
      if (key1 && key2 && key1 == key2 && arr1[i].val == arr2[i].val)
        continue;
      if (arr1[i] !== arr2[i]) return false;
    }
    return true;
  },
  range: (start, count) =>
    Array.apply(0, Array(count)).map((element, index) => index + start),

  flattenArray: items => {
    var out = [];
    items.filter(i=>i).forEach(function(item) {
      if (Array.isArray(item))
        out = out.concat(item);
      else
        out.push(item);
    })
    return out;
  },
  synchArray: ar => {
    var isSynch = ar.filter(v=> v &&  (typeof v.then == 'function' || typeof v.subscribe == 'function')).length == 0;
    if (isSynch) return ar;

    var _ar = ar.filter(x=>x).map(v=>
      (typeof v.then == 'function' || typeof v.subscribe == 'function') ? v : [v]);

    return jb.rx.Observable.from(_ar)
          .concatMap(x=>x)
          .flatMap(v =>
            Array.isArray(v) ? v : [v])
          .toArray()
          .toPromise()
  },
  unique: (ar,f) => {
    f = f || (x=>x);
    var keys = {}, res = [];
    ar.forEach(e=>{
      if (!keys[f(e)]) {
        keys[f(e)] = true;
        res.push(e)
      }
    })
    return res;
  },

  equals: (x,y) =>
    x == y || jb.val(x) == jb.val(y),

  delay: mSec =>
    new Promise(r=>{setTimeout(r,mSec)}),

  // valueByRef API
  refHandler: ref =>
    (ref && ref.handler) || jb.valueByRefHandler,
  writeValue: (ref,value,srcCtx) =>
    jb.refHandler(ref).writeValue(ref,value,srcCtx),
  splice: (ref,args,srcCtx) =>
    jb.refHandler(ref).splice(ref,args,srcCtx),
  move: (fromRef,toRef,srcCtx) =>
    jb.refHandler(fromRef).move(fromRef,toRef,srcCtx),
  isRef: (ref) =>
    jb.refHandler(ref).isRef(ref),
  refreshRef: (ref) =>
    jb.refHandler(ref).refresh(ref),
  asRef: (obj) =>
    jb.valueByRefHandler.asRef(obj),
  resourceChange: _ =>
    jb.valueByRefHandler.resourceChange,
})
;

jb.component('call', {
 	type: '*',
 	params: [
 		{ id: 'param', as: 'string' }
 	],
 	impl: function(context,param) {
 	  var paramObj = context.componentContext && context.componentContext.params[param];
      if (typeof(paramObj) == 'function')
 		return paramObj(new jb.jbCtx(context, {
 			data: context.data,
 			vars: context.vars,
 			componentContext: context.componentContext.componentContext,
 			forcePath: paramObj.srcPath // overrides path - use the former path
 		}));
      else
        return paramObj;
 	}
});

jb.pipe = function(context,items,ptName) {
	var start = [jb.toarray(context.data)[0]]; // use only one data item, the first or null
	if (typeof context.profile.items == 'string')
		return context.runInner(context.profile.items,null,'items');
	var profiles = jb.toarray(context.profile.items || context.profile[ptName]);
	if (context.profile.items && context.profile.items.sugar)
		var innerPath =  '' ;
	else
		var innerPath = context.profile[ptName] ? (ptName + '~') : 'items~';

	if (ptName == '$pipe') // promise pipe
		return profiles.reduce((deferred,prof,index) => {
			return deferred.then(data=>
				jb.synchArray(data))
			.then(data=>
				step(prof,index,data))
		}, Promise.resolve(start))

	return profiles.reduce((data,prof,index) =>
		step(prof,index,data), start)


	function step(profile,i,data) {
    if (profile && profile.$disabled) return data;
		var parentParam = (i == profiles.length - 1 && context.parentParam) ? context.parentParam : { as: 'array'};
		if (jb.profileType(profile) == 'aggregator')
			return jb.run( new jb.jbCtx(context, { data: data, profile: profile, path: innerPath+i }), parentParam);
		return [].concat.apply([],data.map(item =>
				jb.run(new jb.jbCtx(context,{data: item, profile: profile, path: innerPath+i}), parentParam))
			.filter(x=>x!=null)
			.map(x=> Array.isArray(jb.val(x)) ? jb.val(x) : x ));
	}
}

jb.component('pipeline',{
	type: 'data',
	description: 'map data arrays one after the other',
	params: [
		{ id: 'items', type: "data,aggregator[]", ignore: true, essential: true, composite: true },
	],
	impl: (ctx,items) => jb.pipe(ctx,items,'$pipeline')
})

jb.component('pipe', { // synched pipeline
	type: 'data',
	description: 'map asynch data arrays',
	params: [
		{ id: 'items', type: "data,aggregator[]", ignore: true, essential: true, composite: true },
	],
	impl: (ctx,items) => jb.pipe(ctx,items,'$pipe')
})

jb.component('data.if', {
 	type: 'data',
 	params: [
 		{ id: 'condition', type: 'boolean', as: 'boolean', essential: true},
 		{ id: 'then', essential: true, dynamic: true },
 		{ id: 'else', dynamic: true },
 	],
 	impl: (ctx,cond,_then,_else) =>
 		cond ? _then() : _else()
});

jb.component('action.if', {
 	type: 'action',
 	description: 'if then else',
 	params: [
 		{ id: 'condition', type: 'boolean', as: 'boolean', essential: true},
 		{ id: 'then', type: 'action', essential: true, dynamic: true },
 		{ id: 'else', type: 'action', dynamic: true },
 	],
 	impl: (ctx,cond,_then,_else) =>
 		cond ? _then() : _else()
});

// jb.component('apply', {
// 	description: 'run a function',
//  	type: '*',
//  	params: [
//  		{ id: 'func', as: 'single'},
//  	],
//  	impl: (ctx,func) => {
//  		if (typeof func == 'function')
//  	  		return func(ctx);
//  	}
// });

jb.component('jb-run', {
 	type: 'action',
 	params: [
 		{ id: 'profile', as: 'string', essential: true, description: 'profile name'},
 		{ id: 'params', as: 'single' },
 	],
 	impl: (ctx,profile,params) =>
 		ctx.run(Object.assign({$:profile},params || {}))
});


jb.component('list', {
	type: 'data',
	description: 'also flatten arrays',
	params: [
		{ id: 'items', type: "data[]", as: 'array', composite: true }
	],
	impl: function(context,items) {
		var out = [];
		items.forEach(item => {
			if (Array.isArray(item))
				out = out.concat(item);
			else
				out.push(item);
		});
		return out;
	}
});

jb.component('firstSucceeding', {
	type: 'data',
	params: [
		{ id: 'items', type: "data[]", as: 'array', composite: true }
	],
	impl: function(context,items) {
		for(var i=0;i<items.length;i++)
			if (jb.val(items[i]))
				return items[i];
		// return last one if zero or empty string
		var last = items.slice(-1)[0];
		return (last != null) && jb.val(last);
	}
});

jb.component('first', {
	type: 'data',
	params: [
		{ id: 'items', type: "data", as: 'array', composite: true }
	],
	impl: (ctx,items) => items[0]
});

jb.component('property-names', {
	type: 'data',
  description: 'Object.getOwnPropertyNames',
	params: [
		{ id: 'obj', defaultValue: '%%', as: 'single' }
	],
	impl: (ctx,obj) =>
		jb.ownPropertyNames(obj).filter(p=>p.indexOf('$jb_') != 0)
})

jb.component('properties',{
	type: 'data',
	params: [
		{ id: 'obj', defaultValue: '%%', as: 'single' }
	],
	impl: (context,obj) =>
		jb.ownPropertyNames(obj).filter(p=>p.indexOf('$jb_') != 0).map((id,index) =>
			({id: id, val: obj[id], index: index}))
});

jb.component('prefix', {
	type: 'data',
	params: [
		{ id: 'separator', as: 'string', essential: true },
		{ id: 'text', as: 'string', defaultValue: '%%' },
	],
	impl: (context,separator,text) =>
		(text||'').substring(0,text.indexOf(separator))
});

jb.component('suffix', {
	type: 'data',
	params: [
		{ id: 'separator', as: 'string', essential: true },
		{ id: 'text', as: 'string', defaultValue: '%%' },
	],
	impl: (context,separator,text) =>
		(text||'').substring(text.lastIndexOf(separator)+separator.length)
});

jb.component('remove-prefix', {
	type: 'data',
	params: [
		{ id: 'separator', as: 'string', essential: true },
		{ id: 'text', as: 'string', defaultValue: '%%' },
	],
	impl: (context,separator,text) =>
		text.indexOf(separator) == -1 ? text : text.substring(text.indexOf(separator)+separator.length)
});

jb.component('remove-suffix',{
	type: 'data',
	params: [
		{ id: 'separator', as: 'string', essential: true },
		{ id: 'text', as: 'string', defaultValue: '%%' },
	],
	impl: (context,separator,text) =>
		text.lastIndexOf(separator) == -1 ? text : text.substring(0,text.lastIndexOf(separator))
});

jb.component('remove-suffix-regex',{
	type: 'data',
	params: [
		{ id: 'suffix', as: 'string', essential: true, description: 'regular expression. e.g [0-9]*' },
		{ id: 'text', as: 'string', defaultValue: '%%' },
	],
	impl: function(context,suffix,text) {
		context.profile.prefixRegexp = context.profile.prefixRegexp || new RegExp(suffix+'$');
		var m = (text||'').match(context.profile.prefixRegexp);
		return (m && (text||'').substring(m.index+1)) || text;
	}
});

jb.component('write-value',{
	type: 'action',
	params: [
		{ id: 'to', as: 'ref', essential: true },
		{ id: 'value', essential: true}
	],
	impl: (ctx,to,value) =>
		jb.writeValue(to,jb.val(value),ctx)
});

jb.component('remove-from-array', {
	type: 'action',
	params: [
		{ id: 'array', as: 'ref', essential: true },
		{ id: 'itemToRemove', as: 'single', description: 'choose item or index' },
		{ id: 'index', as: 'number', description: 'choose item or index' },
	],
	impl: (ctx,array,itemToRemove,index) => {
		var ar = jb.toarray(array);
		var index = itemToRemove ? ar.indexOf(item) : index;
		if (index != -1 && ar.length > index)
			jb.splice(array,[[index,1]],ctx)
	}
});

jb.component('toggle-boolean-value',{
	type: 'action',
	params: [
		{ id: 'of', as: 'ref' },
	],
	impl: (ctx,_of) =>
		jb.writeValue(_of,jb.val(_of) ? false : true)
});


jb.component('slice', {
	type: 'aggregator',
	params: [
		{ id: 'start', as: 'number', defaultValue: 0, description: '0-based index', essential: true },
		{ id: 'end', as: 'number', essential: true, description: '0-based index of where to end the selection (not including itself)' }
	],
	impl: function(context,begin,end) {
		if (!context.data || !context.data.slice) return null;
		return end ? context.data.slice(begin,end) : context.data.slice(begin);
	}
});

jb.component('sort', { 
	type: 'aggregator',
	params: [
		{ id: 'propertyName', as: 'string', description: 'sort by property inside object' },
		{ id: 'lexical', as: 'boolean', type: 'boolean' },
		{ id: 'ascending', as: 'boolean', type: 'boolean' }, 
	],
	impl: (ctx,prop,lexical,ascending) => {
		if (!ctx.data || ! Array.isArray(ctx.data)) return null;
		if (lexical)
			var sortFunc = prop ? (x,y) => (x[prop] == y[prop] ? 0 : x[prop] < y[prop] ? -1 : 1) : (x,y) => (x == y ? 0 : x < y ? -1 : 1);
		else 
			var sortFunc = prop ? (x,y) => (x-y) : (x,y) => (x[prop]-y[prop]);
		if (ascending)
			return ctx.data.slice(0).sort((x,y)=>sortFunc(y,x));
		return ctx.data.slice(0).sort((x,y)=>sortFunc(x,y));
	}
});

jb.component('wrap-as-object', {
	type: 'aggregator',
	params: [
    {id: 'arrayProperty', as: 'string', defaultValue: 'items'}
	],
	impl: (ctx,prop) =>
    jb.obj(prop,ctx.data)
});


jb.component('not', {
	type: 'boolean',
	params: [
		{ id: 'of', type: 'boolean', as: 'boolean', essential: true, composite: true}
	],
	impl: (context, of) => !of
});

jb.component('and', {
	type: 'boolean',
	params: [
		{ id: 'items', type: 'boolean[]', ignore: true, essential: true, composite: true }
	],
	impl: function(context) {
		var items = context.profile.$and || context.profile.items || [];
		var innerPath =  context.profile.$and ? '$and~' : 'items~';
		for(var i=0;i<items.length;i++) {
			if (!context.runInner(items[i], { type: 'boolean' }, innerPath + i))
				return false;
		}
		return true;
	}
});

jb.component('or', {
	type: 'boolean',
	params: [
		{ id: 'items', type: 'boolean[]', ignore: true, essential: true, composite: true }
	],
	impl: function(context) {
		var items = context.profile.$or || context.profile.items || [];
		var innerPath =  context.profile.$or ? '$or~' : 'items~';
		for(var i=0;i<items.length;i++) {
			if (context.runInner(items[i],{ type: 'boolean' },innerPath+i))
				return true;
		}
		return false;
	}
});

jb.component('contains',{
	type: 'boolean',
	params: [
		{ id: 'text', type: 'data[]', as: 'array', essential: true },
		{ id: 'allText', defaultValue: '%%', as:'string'},
		{ id: 'inOrder', defaultValue: true, as:'boolean'},
	],
	impl: function(context,text,allText,inOrder) {
      var prevIndex = -1;
      for(var i=0;i<text.length;i++) {
      	var newIndex = allText.indexOf(jb.tostring(text[i]),prevIndex+1);
      	if (newIndex == -1) return false;
      	prevIndex = inOrder ? newIndex : -1;
      }
      return true;
	}
})

jb.component('not-contains', {
	type: 'boolean',
	params: [
		{ id: 'text', type: 'data[]', as: 'array', essential: true },
		{ id: 'allText', defaultValue: '%%', as:'array'}
	],
	impl :{$not: {$: 'contains', text: '%$text%', allText :'%$allText%'}}
})

jb.component('starts-with', {
	type: 'boolean',
	params: [
		{ id: 'startsWith', as: 'string', essential: true },
		{ id: 'text', defaultValue: '%%', as:'string'}
	],
	impl: (context,startsWith,text) =>
		text.lastIndexOf(startsWith,0) == 0
})

jb.component('ends-with',{
	type: 'boolean',
	params: [
		{ id: 'endsWith', as: 'string', essential: true },
		{ id: 'text', defaultValue: '%%', as:'string'}
	],
	impl: (context,endsWith,text) =>
		text.indexOf(endsWith,text.length-endsWith.length) !== -1
})


jb.component('filter',{
	type: 'aggregator',
	params: [
		{ id: 'filter', type: 'boolean', as: 'boolean', dynamic: true, essential: true }
	],
	impl: (context,filter) =>
		jb.toarray(context.data).filter(item =>
			filter(context,item))
});

jb.component('count', {
	type: 'aggregator',
	description: 'length, size of array',
	params: [{ id: 'items', as:'array', defaultValue: '%%'}],
	impl: (ctx,items) =>
		items.length
});

jb.component('to-string', {
	params: [
		{ id: 'text', as: 'string', defaultValue: '%%', composite: true}
	],
	impl: (ctx,text) =>	text
});

jb.component('to-uppercase', {
	params: [
		{ id: 'text', as: 'string', defaultValue: '%%'}
	],
	impl: (ctx,text) =>
		text.toUpperCase()
});

jb.component('to-lowercase', {
	params: [
		{ id: 'text', as: 'string', defaultValue: '%%'}
	],
	impl: (ctx,text) =>
		text.toLowerCase()
});

jb.component('capitalize', {
	params: [
		{ id: 'text', as: 'string', defaultValue: '%%'}
	],
	impl: (ctx,text) =>
		text.charAt(0).toUpperCase() + text.slice(1)
});

jb.component('join', {
	params: [
		{ id: 'separator', as: 'string', defaultValue:',', essential: true },
		{ id: 'prefix', as: 'string' },
		{ id: 'suffix', as: 'string' },
		{ id: 'items', as: 'array', defaultValue: '%%'},
		{ id: 'itemName', as: 'string', defaultValue: 'item'},
		{ id: 'itemText', as: 'string', dynamic:true, defaultValue: '%%'}
	],
	type: 'aggregator',
	impl: function(context,separator,prefix,suffix,items,itemName,itemText) {
		var itemToText = (context.profile.itemText) ?
			item => itemText(new jb.jbCtx(context, {data: item, vars: jb.obj(itemName,item) })) :
			item => jb.tostring(item);	// performance

		return prefix + items.map(itemToText).join(separator) + suffix;
	}
});

jb.component('unique', {
	params: [
		{ id: 'id', as: 'string', dynamic: true, defaultValue: '%%' },
		{ id: 'items', as: 'array', defaultValue: '%%'}
	],
	type: 'aggregator',
	impl: (ctx,idFunc,items) => {
		var _idFunc = idFunc.profile == '%%' ? x=>x : x => idFunc(ctx.setData(x));
		return jb.unique(items,_idFunc);
	}
});

jb.component('log', {
	params: [
		{ id: 'obj', as: 'single', defaultValue: '%%'}
	],
	impl: function(context,obj) {
		var out = obj;
		if (typeof GLOBAL != 'undefined' && typeof(obj) == 'object')
			out = JSON.stringify(obj,null," ");
		if (typeof window != 'undefined')
			(window.parent || window).console.log(out);
		else
			console.log(out);
		return out;
	}
});

jb.component('asIs',{ params: [{id: '$asIs'}], impl: ctx => context.profile.$asIs });

jb.component('object',{
	impl: function(context) {
		var result = {};
		var obj = context.profile.$object || context.profile;
		if (Array.isArray(obj)) return obj;
		for(var prop in obj) {
			if ((prop == '$' && obj[prop] == 'object') || obj[prop] == null)
				continue;
			result[prop] = context.runInner(obj[prop],null,prop);
		}
		return result;
	}
});

jb.component('json.stringify', {
	params: [
		{ id: 'value', defaultValue: '%%' },
		{ id: 'space', as: 'string', description: 'use space or tab to make pretty output' }
	],
	impl: (context,value,space) =>
			JSON.stringify(value,null,space)
});

jb.component('json.parse', {
	params: [
		{ id: 'text', as: 'string' }
	],
	impl: (ctx,text) =>	{
		try {
			return JSON.parse(text)
		} catch (e) {
			jb.logException(e,'json parse');
		}
	}
});

jb.component('split', {
	type: 'data',
	params: [
		{ id: 'separator', as: 'string', defaultValue: ',' },
		{ id: 'text', as: 'string', defaultValue: '%%'},
		{ id: 'part', options: ',first,second,last,but first,but last' }
	],
	impl: function(context,separator,text,part) {
		var out = text.split(separator.replace(/\\r\\n/g,'\n').replace(/\\n/g,'\n'));
		switch (part) {
			case 'first': return out[0];
			case 'second': return out[1];
			case 'last': return out.pop();
			case 'but first': return out.slice(1);
			case 'but last': return out.slice(0,-1);
			default: return out;
		}
	}
});

jb.component('replace', {
	type: 'data',
	params: [
		{ id: 'find', as: 'string', essential: true },
		{ id: 'replace', as: 'string', essential: true  },
		{ id: 'text', as: 'string', defaultValue: '%%' },
		{ id: 'useRegex', type: 'boolean', as: 'boolean', defaultValue: true},
		{ id: 'regexFlags', as: 'string', defaultValue: 'g', description: 'g,i,m' }
	],
	impl: function(context,find,replace,text,useRegex,regexFlags) {
		if (useRegex) {
			return text.replace(new RegExp(find,regexFlags) ,replace);
		} else
			return text.replace(find,replace);
	}
});

jb.component('touch', {
	type: 'action',
	params: [
		{ id: 'data', as: 'ref'},
	],
	impl: function(context,data_ref) {
		var val = Number(jb.val(data_ref));
		jb.writeValue(data_ref,val ? val + 1 : 1);
	}
});

jb.component('isNull', {
	type: 'boolean',
	params: [
		{ id: 'obj', defaultValue: '%%'}
	],
	impl: (ctx, obj) => jb.val(obj) == null
});

jb.component('isEmpty', {
	type: 'boolean',
	params: [
		{ id: 'item', as: 'single', defaultValue: '%%'}
	],
	impl: (ctx, item) =>
		!item || (Array.isArray(item) && item.length == 0)
});

jb.component('notEmpty', {
	type: 'boolean',
	params: [
		{ id: 'item', as: 'single', defaultValue: '%%'}
	],
	impl: (ctx, item) =>
		item && !(Array.isArray(item) && item.length == 0)
});

jb.component('equals', {
	type: 'boolean',
	params: [
		{ id: 'item1', as: 'single', essential: true },
		{ id: 'item2', defaultValue: '%%', as: 'single' }
	],
	impl: (ctx, item1, item2) => item1 == item2
});

jb.component('not-equals', {
	type: 'boolean',
	params: [
		{ id: 'item1', as: 'single', essential: true },
		{ id: 'item2', defaultValue: '%%', as: 'single' }
	],
	impl: (ctx, item1, item2) => item1 != item2
});

jb.component('parent', {
	type: 'data',
	params: [
		{ id: 'item', as: 'ref', defaultValue: '%%'}
	],
	impl: (ctx,item) =>
		item && item.$jb_parent
});

jb.component('runActions', {
	type: 'action',
	params: [
		{ id: 'actions', type:'action[]', ignore: true, composite: true, essential: true }
	],
	impl: function(context) {
		if (!context.profile) debugger;
		var actions = jb.toarray(context.profile.actions || context.profile['$runActions']);
		if (context.profile.actions && context.profile.actions.sugar)
			var innerPath =  '' ;
		else
			var innerPath = context.profile['$runActions'] ? '$runActions~' : 'items~';
		return actions.reduce((def,action,index) =>
				def.then(_ => context.runInner(action, { as: 'single'}, innerPath + index ))
			,Promise.resolve())
	}
});

// jb.component('delay', {
// 	params: [
// 		{ id: 'mSec', type: 'number', defaultValue: 1}
// 	],
// 	impl: ctx => jb.delay(ctx.params.mSec)
// })

jb.component('on-next-timer', {
	description: 'run action after delay',
	type: 'action',
	params: [
		{ id: 'action', type: 'action', dynamic: true, essential: true },
		{ id: 'delay', type: 'number', defaultValue: 1}
	],
	impl: (ctx,action,delay) =>
		jb.delay(delay,ctx).then(()=>
			action())
})

jb.component('extract-prefix',{
	type: 'data',
	params: [
		{ id: 'separator', as: 'string', description: '/w- alphnumberic, /s- whitespace, ^- beginline, $-endline'},
		{ id: 'text', as: 'string', defaultValue: '%%'},
		{ id: 'regex', type: 'boolean', as: 'boolean', description: 'separator is regex' },
		{ id: 'keepSeparator', type: 'boolean', as: 'boolean' }
	],
	impl: function(context,separator,text,regex,keepSeparator) {
		if (!regex) {
			return text.substring(0,text.indexOf(separator)) + (keepSeparator ? separator : '');
		} else { // regex
			var match = text.match(separator);
			if (match)
				return text.substring(0,match.index) + (keepSeparator ? match[0] : '');
		}
	}
});

jb.component('extract-suffix',{
	type: 'data',
	params: [
		{ id: 'separator', as: 'string', description: '/w- alphnumberic, /s- whitespace, ^- beginline, $-endline'},
		{ id: 'text', as: 'string', defaultValue: '%%'},
		{ id: 'regex', type: 'boolean', as: 'boolean', description: 'separator is regex' },
		{ id: 'keepSeparator', type: 'boolean', as: 'boolean' }
	],
	impl: function(context,separator,text,regex,keepSeparator) {
		if (!regex) {
			return text.substring(text.lastIndexOf(separator) + (keepSeparator ? 0 : separator.length));
		} else { // regex
			var match = text.match(separator+'(?![\\s\\S]*' + separator +')'); // (?!) means not after, [\\s\\S]* means any char including new lines
			if (match)
				return text.substring(match.index + (keepSeparator ? 0 : match[0].length));
		}
	}
});

jb.component('range', {
	type: 'data',
	params: [
		{ id: 'from', as: 'number', defaultValue: 1 },
		{ id: 'to', as: 'number', defaultValue: 10 },
	],
	impl: (ctx,from,to) =>
    Array.from(Array(to-from+1).keys()).map(x=>x+from)
})

jb.component('type-of', {
	type: 'data',
	params: [
		{ id: 'obj', defaultValue: '%%' },
	],
	impl: (ctx,_obj) => {
	  	var obj = jb.val(_obj);
		return Array.isArray(obj) ? 'array' : typeof obj
	}
})

jb.component('class-name', {
	type: 'data',
	params: [
		{ id: 'obj', defaultValue: '%%' },
	],
	impl: (ctx,_obj) => {
	  	var obj = jb.val(_obj);
		return obj && obj.constructor && obj.constructor.name
	}
})

jb.component('is-of-type', {
  type: 'boolean',
  params: [
  	{ id: 'type', as: 'string', essential: true, description: 'string,boolean' },
  	{ id: 'obj', defaultValue: '%%' },
  ],
  impl: (ctx,_type,_obj) => {
  	var obj = jb.val(_obj);
  	var objType = Array.isArray(obj) ? 'array' : typeof obj;
  	return _type.split(',').indexOf(objType) != -1;
  }
})

jb.component('in-group', {
  type: 'boolean',
  params: [
  	{ id: 'group', as: 'array', essential: true },
  	{ id: 'item', as: 'single', defaultValue: '%%' },
  ],
  impl: (ctx,group,item) =>
  	group.indexOf(item) != -1
})

jb.component('http.get', {
	params: [
		{ id: 'url', as: 'string' },
		{ id: 'json', as: 'boolean', description: 'convert result to json' }
	],
	impl: (ctx,url,_json) => {
		if (ctx.probe)
			return jb.http_get_cache[url];
		var json = _json || url.match(/json$/);
		return fetch(url)
			  .then(r =>
			  		json ? r.json() : r.text())
				.then(res=> jb.http_get_cache ? (jb.http_get_cache[url] = res) : res)
			  .catch(e => jb.logException(e) || [])
	}
});

jb.component('http.post', {
  type: 'action',
	params: [
		{ id: 'url', as: 'string' },
    { id: 'postData', as: 'single' },
		{ id: 'jsonResult', as: 'boolean', description: 'convert result to json' }
	],
	impl: (ctx,url,postData,json) => {
    var headers = new Headers();
    headers.append("Content-Type", "application/json; charset=UTF-8");
		return fetch(url,{method: 'POST', headers: headers, body: JSON.stringify(postData) })
			  .then(r =>
			  		json ? r.json() : r.text())
			  .catch(e => jb.logException(e) || [])
	}
});

jb.component('isRef', {
	params: [
		{ id: 'obj', essential: true }
	],
	impl: (ctx,obj) => jb.isRef(obj)
})

jb.component('asRef', {
	params: [
		{ id: 'obj', essential: true }
	],
	impl: (ctx,obj) => jb.asRef(obj)
})

jb.component('data.switch', {
  params: [
  	{ id: 'cases', type: 'data.switch-case[]', as: 'array', essential: true, defaultValue: [] },
  	{ id: 'default', dynamic: true },
  ],
  impl: (ctx,cases,defaultValue) => {
  	for(var i=0;i<cases.length;i++)
  		if (cases[i].condition(ctx))
  			return cases[i].value(ctx)
  	return defaultValue(ctx);
  }
})

jb.component('data.switch-case', {
  type: 'data.switch-case',
  singleInType: true,
  params: [
  	{ id: 'condition', type: 'boolean', essential: true, dynamic: true },
  	{ id: 'value', essential: true, dynamic: true },
  ],
  impl: ctx => ctx.params
})

jb.component('action.switch', {
  type: 'action',
  params: [
  	{ id: 'cases', type: 'action.switch-case[]', as: 'array', essential: true, defaultValue: [] },
  	{ id: 'defaultAction', type: 'action', dynamic: true },
  ],
  impl: (ctx,cases,defaultAction) => {
  	for(var i=0;i<cases.length;i++)
  		if (cases[i].condition(ctx))
  			return cases[i].action(ctx)
  	return defaultAction(ctx);
  }
})

jb.component('action.switch-case', {
  type: 'action.switch-case',
  singleInType: true,
  params: [
  	{ id: 'condition', type: 'boolean', as: 'boolean', essential: true, dynamic: true },
  	{ id: 'action', type: 'action' ,essential: true, dynamic: true },
  ],
  impl: ctx => ctx.params
})
;

;(function() {
"use strict";

/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A component handler interface using the revealing module design pattern.
 * More details on this design pattern here:
 * https://github.com/jasonmayes/mdl-component-design-pattern
 *
 * @author Jason Mayes.
 */
/* exported componentHandler */

// Pre-defining the componentHandler interface, for closure documentation and
// static verification.
var componentHandler = {
  /**
   * Searches existing DOM for elements of our component type and upgrades them
   * if they have not already been upgraded.
   *
   * @param {string=} optJsClass the programatic name of the element class we
   * need to create a new instance of.
   * @param {string=} optCssClass the name of the CSS class elements of this
   * type will have.
   */
  upgradeDom: function(optJsClass, optCssClass) {},
  /**
   * Upgrades a specific element rather than all in the DOM.
   *
   * @param {!Element} element The element we wish to upgrade.
   * @param {string=} optJsClass Optional name of the class we want to upgrade
   * the element to.
   */
  upgradeElement: function(element, optJsClass) {},
  /**
   * Upgrades a specific list of elements rather than all in the DOM.
   *
   * @param {!Element|!Array<!Element>|!NodeList|!HTMLCollection} elements
   * The elements we wish to upgrade.
   */
  upgradeElements: function(elements) {},
  /**
   * Upgrades all registered components found in the current DOM. This is
   * automatically called on window load.
   */
  upgradeAllRegistered: function() {},
  /**
   * Allows user to be alerted to any upgrades that are performed for a given
   * component type
   *
   * @param {string} jsClass The class name of the MDL component we wish
   * to hook into for any upgrades performed.
   * @param {function(!HTMLElement)} callback The function to call upon an
   * upgrade. This function should expect 1 parameter - the HTMLElement which
   * got upgraded.
   */
  registerUpgradedCallback: function(jsClass, callback) {},
  /**
   * Registers a class for future use and attempts to upgrade existing DOM.
   *
   * @param {componentHandler.ComponentConfigPublic} config the registration configuration
   */
  register: function(config) {},
  /**
   * Downgrade either a given node, an array of nodes, or a NodeList.
   *
   * @param {!Node|!Array<!Node>|!NodeList} nodes
   */
  downgradeElements: function(nodes) {}
};

componentHandler = (function() {
  'use strict';

  /** @type {!Array<componentHandler.ComponentConfig>} */
  var registeredComponents_ = [];

  /** @type {!Array<componentHandler.Component>} */
  var createdComponents_ = [];

  var componentConfigProperty_ = 'mdlComponentConfigInternal_';

  /**
   * Searches registered components for a class we are interested in using.
   * Optionally replaces a match with passed object if specified.
   *
   * @param {string} name The name of a class we want to use.
   * @param {componentHandler.ComponentConfig=} optReplace Optional object to replace match with.
   * @return {!Object|boolean}
   * @private
   */
  function findRegisteredClass_(name, optReplace) {
    for (var i = 0; i < registeredComponents_.length; i++) {
      if (registeredComponents_[i].className === name) {
        if (typeof optReplace !== 'undefined') {
          registeredComponents_[i] = optReplace;
        }
        return registeredComponents_[i];
      }
    }
    return false;
  }

  /**
   * Returns an array of the classNames of the upgraded classes on the element.
   *
   * @param {!Element} element The element to fetch data from.
   * @return {!Array<string>}
   * @private
   */
  function getUpgradedListOfElement_(element) {
    var dataUpgraded = element.getAttribute('data-upgraded');
    // Use `['']` as default value to conform the `,name,name...` style.
    return dataUpgraded === null ? [''] : dataUpgraded.split(',');
  }

  /**
   * Returns true if the given element has already been upgraded for the given
   * class.
   *
   * @param {!Element} element The element we want to check.
   * @param {string} jsClass The class to check for.
   * @returns {boolean}
   * @private
   */
  function isElementUpgraded_(element, jsClass) {
    var upgradedList = getUpgradedListOfElement_(element);
    return upgradedList.indexOf(jsClass) !== -1;
  }

  /**
   * Create an event object.
   *
   * @param {string} eventType The type name of the event.
   * @param {boolean} bubbles Whether the event should bubble up the DOM.
   * @param {boolean} cancelable Whether the event can be canceled.
   * @returns {!Event}
   */
  function createEvent_(eventType, bubbles, cancelable) {
    if ('CustomEvent' in window && typeof window.CustomEvent === 'function') {
      return new CustomEvent(eventType, {
        bubbles: bubbles,
        cancelable: cancelable
      });
    } else {
      var ev = document.createEvent('Events');
      ev.initEvent(eventType, bubbles, cancelable);
      return ev;
    }
  }

  /**
   * Searches existing DOM for elements of our component type and upgrades them
   * if they have not already been upgraded.
   *
   * @param {string=} optJsClass the programatic name of the element class we
   * need to create a new instance of.
   * @param {string=} optCssClass the name of the CSS class elements of this
   * type will have.
   */
  function upgradeDomInternal(optJsClass, optCssClass) {
    if (typeof optJsClass === 'undefined' &&
        typeof optCssClass === 'undefined') {
      for (var i = 0; i < registeredComponents_.length; i++) {
        upgradeDomInternal(registeredComponents_[i].className,
            registeredComponents_[i].cssClass);
      }
    } else {
      var jsClass = /** @type {string} */ (optJsClass);
      if (typeof optCssClass === 'undefined') {
        var registeredClass = findRegisteredClass_(jsClass);
        if (registeredClass) {
          optCssClass = registeredClass.cssClass;
        }
      }

      var elements = document.querySelectorAll('.' + optCssClass);
      for (var n = 0; n < elements.length; n++) {
        upgradeElementInternal(elements[n], jsClass);
      }
    }
  }

  /**
   * Upgrades a specific element rather than all in the DOM.
   *
   * @param {!Element} element The element we wish to upgrade.
   * @param {string=} optJsClass Optional name of the class we want to upgrade
   * the element to.
   */
  function upgradeElementInternal(element, optJsClass) {
    // Verify argument type.
    if (!(typeof element === 'object' && element instanceof Element)) {
      throw new Error('Invalid argument provided to upgrade MDL element.');
    }
    // Allow upgrade to be canceled by canceling emitted event.
    var upgradingEv = createEvent_('mdl-componentupgrading', true, true);
    element.dispatchEvent(upgradingEv);
    if (upgradingEv.defaultPrevented) {
      return;
    }

    var upgradedList = getUpgradedListOfElement_(element);
    var classesToUpgrade = [];
    // If jsClass is not provided scan the registered components to find the
    // ones matching the element's CSS classList.
    if (!optJsClass) {
      var classList = element.classList;
      registeredComponents_.forEach(function(component) {
        // Match CSS & Not to be upgraded & Not upgraded.
        if (classList.contains(component.cssClass) &&
            classesToUpgrade.indexOf(component) === -1 &&
            !isElementUpgraded_(element, component.className)) {
          classesToUpgrade.push(component);
        }
      });
    } else if (!isElementUpgraded_(element, optJsClass)) {
      classesToUpgrade.push(findRegisteredClass_(optJsClass));
    }

    // Upgrade the element for each classes.
    for (var i = 0, n = classesToUpgrade.length, registeredClass; i < n; i++) {
      registeredClass = classesToUpgrade[i];
      if (registeredClass) {
        // Mark element as upgraded.
        upgradedList.push(registeredClass.className);
        element.setAttribute('data-upgraded', upgradedList.join(','));
        var instance = new registeredClass.classConstructor(element);
        instance[componentConfigProperty_] = registeredClass;
        createdComponents_.push(instance);
        // Call any callbacks the user has registered with this component type.
        for (var j = 0, m = registeredClass.callbacks.length; j < m; j++) {
          registeredClass.callbacks[j](element);
        }

        if (registeredClass.widget) {
          // Assign per element instance for control over API
          element[registeredClass.className] = instance;
        }
      } else {
        throw new Error(
          'Unable to find a registered component for the given class.');
      }

      var upgradedEv = createEvent_('mdl-componentupgraded', true, false);
      element.dispatchEvent(upgradedEv);
    }
  }

  /**
   * Upgrades a specific list of elements rather than all in the DOM.
   *
   * @param {!Element|!Array<!Element>|!NodeList|!HTMLCollection} elements
   * The elements we wish to upgrade.
   */
  function upgradeElementsInternal(elements) {
    if (!Array.isArray(elements)) {
      if (elements instanceof Element) {
        elements = [elements];
      } else {
        elements = Array.prototype.slice.call(elements);
      }
    }
    for (var i = 0, n = elements.length, element; i < n; i++) {
      element = elements[i];
      if (element instanceof HTMLElement) {
        upgradeElementInternal(element);
        if (element.children.length > 0) {
          upgradeElementsInternal(element.children);
        }
      }
    }
  }

  /**
   * Registers a class for future use and attempts to upgrade existing DOM.
   *
   * @param {componentHandler.ComponentConfigPublic} config
   */
  function registerInternal(config) {
    // In order to support both Closure-compiled and uncompiled code accessing
    // this method, we need to allow for both the dot and array syntax for
    // property access. You'll therefore see the `foo.bar || foo['bar']`
    // pattern repeated across this method.
    var widgetMissing = (typeof config.widget === 'undefined' &&
        typeof config['widget'] === 'undefined');
    var widget = true;

    if (!widgetMissing) {
      widget = config.widget || config['widget'];
    }

    var newConfig = /** @type {componentHandler.ComponentConfig} */ ({
      classConstructor: config.constructor || config['constructor'],
      className: config.classAsString || config['classAsString'],
      cssClass: config.cssClass || config['cssClass'],
      widget: widget,
      callbacks: []
    });

    registeredComponents_.forEach(function(item) {
      if (item.cssClass === newConfig.cssClass) {
        throw new Error('The provided cssClass has already been registered: ' + item.cssClass);
      }
      if (item.className === newConfig.className) {
        throw new Error('The provided className has already been registered');
      }
    });

    if (config.constructor.prototype
        .hasOwnProperty(componentConfigProperty_)) {
      throw new Error(
          'MDL component classes must not have ' + componentConfigProperty_ +
          ' defined as a property.');
    }

    var found = findRegisteredClass_(config.classAsString, newConfig);

    if (!found) {
      registeredComponents_.push(newConfig);
    }
  }

  /**
   * Allows user to be alerted to any upgrades that are performed for a given
   * component type
   *
   * @param {string} jsClass The class name of the MDL component we wish
   * to hook into for any upgrades performed.
   * @param {function(!HTMLElement)} callback The function to call upon an
   * upgrade. This function should expect 1 parameter - the HTMLElement which
   * got upgraded.
   */
  function registerUpgradedCallbackInternal(jsClass, callback) {
    var regClass = findRegisteredClass_(jsClass);
    if (regClass) {
      regClass.callbacks.push(callback);
    }
  }

  /**
   * Upgrades all registered components found in the current DOM. This is
   * automatically called on window load.
   */
  function upgradeAllRegisteredInternal() {
    for (var n = 0; n < registeredComponents_.length; n++) {
      upgradeDomInternal(registeredComponents_[n].className);
    }
  }

  /**
   * Check the component for the downgrade method.
   * Execute if found.
   * Remove component from createdComponents list.
   *
   * @param {?componentHandler.Component} component
   */
  function deconstructComponentInternal(component) {
    if (component) {
      var componentIndex = createdComponents_.indexOf(component);
      createdComponents_.splice(componentIndex, 1);

      var upgrades = component.element_.getAttribute('data-upgraded').split(',');
      var componentPlace = upgrades.indexOf(component[componentConfigProperty_].classAsString);
      upgrades.splice(componentPlace, 1);
      component.element_.setAttribute('data-upgraded', upgrades.join(','));

      var ev = createEvent_('mdl-componentdowngraded', true, false);
      component.element_.dispatchEvent(ev);
    }
  }

  /**
   * Downgrade either a given node, an array of nodes, or a NodeList.
   *
   * @param {!Node|!Array<!Node>|!NodeList} nodes
   */
  function downgradeNodesInternal(nodes) {
    /**
     * Auxiliary function to downgrade a single node.
     * @param  {!Node} node the node to be downgraded
     */
    var downgradeNode = function(node) {
      createdComponents_.filter(function(item) {
        return item.element_ === node;
      }).forEach(deconstructComponentInternal);
    };
    if (nodes instanceof Array || nodes instanceof NodeList) {
      for (var n = 0; n < nodes.length; n++) {
        downgradeNode(nodes[n]);
      }
    } else if (nodes instanceof Node) {
      downgradeNode(nodes);
    } else {
      throw new Error('Invalid argument provided to downgrade MDL nodes.');
    }
  }

  // Now return the functions that should be made public with their publicly
  // facing names...
  return {
    upgradeDom: upgradeDomInternal,
    upgradeElement: upgradeElementInternal,
    upgradeElements: upgradeElementsInternal,
    upgradeAllRegistered: upgradeAllRegisteredInternal,
    registerUpgradedCallback: registerUpgradedCallbackInternal,
    register: registerInternal,
    downgradeElements: downgradeNodesInternal
  };
})();

/**
 * Describes the type of a registered component type managed by
 * componentHandler. Provided for benefit of the Closure compiler.
 *
 * @typedef {{
 *   constructor: Function,
 *   classAsString: string,
 *   cssClass: string,
 *   widget: (string|boolean|undefined)
 * }}
 */
componentHandler.ComponentConfigPublic;  // jshint ignore:line

/**
 * Describes the type of a registered component type managed by
 * componentHandler. Provided for benefit of the Closure compiler.
 *
 * @typedef {{
 *   constructor: !Function,
 *   className: string,
 *   cssClass: string,
 *   widget: (string|boolean),
 *   callbacks: !Array<function(!HTMLElement)>
 * }}
 */
componentHandler.ComponentConfig;  // jshint ignore:line

/**
 * Created component (i.e., upgraded element) type as managed by
 * componentHandler. Provided for benefit of the Closure compiler.
 *
 * @typedef {{
 *   element_: !HTMLElement,
 *   className: string,
 *   classAsString: string,
 *   cssClass: string,
 *   widget: string
 * }}
 */
componentHandler.Component;  // jshint ignore:line

// Export all symbols, for the benefit of Closure compiler.
// No effect on uncompiled code.
componentHandler['upgradeDom'] = componentHandler.upgradeDom;
componentHandler['upgradeElement'] = componentHandler.upgradeElement;
componentHandler['upgradeElements'] = componentHandler.upgradeElements;
componentHandler['upgradeAllRegistered'] =
    componentHandler.upgradeAllRegistered;
componentHandler['registerUpgradedCallback'] =
    componentHandler.registerUpgradedCallback;
componentHandler['register'] = componentHandler.register;
componentHandler['downgradeElements'] = componentHandler.downgradeElements;
window.componentHandler = componentHandler;
window['componentHandler'] = componentHandler;

window.addEventListener('load', function() {
  'use strict';

  /**
   * Performs a "Cutting the mustard" test. If the browser supports the features
   * tested, adds a mdl-js class to the <html> element. It then upgrades all MDL
   * components requiring JavaScript.
   */
  if ('classList' in document.createElement('div') &&
      'querySelector' in document &&
      'addEventListener' in window && Array.prototype.forEach) {
    document.documentElement.classList.add('mdl-js');
    componentHandler.upgradeAllRegistered();
  } else {
    /**
     * Dummy function to avoid JS errors.
     */
    componentHandler.upgradeElement = function() {};
    /**
     * Dummy function to avoid JS errors.
     */
    componentHandler.register = function() {};
  }
});

// Source: https://github.com/darius/requestAnimationFrame/blob/master/requestAnimationFrame.js
// Adapted from https://gist.github.com/paulirish/1579671 which derived from
// http://paulirish.com/2011/requestanimationframe-for-smart-animating/
// http://my.opera.com/emoller/blog/2011/12/20/requestanimationframe-for-smart-er-animating
// requestAnimationFrame polyfill by Erik Möller.
// Fixes from Paul Irish, Tino Zijdel, Andrew Mao, Klemen Slavič, Darius Bacon
// MIT license
if (!Date.now) {
    /**
     * Date.now polyfill.
     * @return {number} the current Date
     */
    Date.now = function () {
        return new Date().getTime();
    };
    Date['now'] = Date.now;
}
var vendors = [
    'webkit',
    'moz'
];
for (var i = 0; i < vendors.length && !window.requestAnimationFrame; ++i) {
    var vp = vendors[i];
    window.requestAnimationFrame = window[vp + 'RequestAnimationFrame'];
    window.cancelAnimationFrame = window[vp + 'CancelAnimationFrame'] || window[vp + 'CancelRequestAnimationFrame'];
    window['requestAnimationFrame'] = window.requestAnimationFrame;
    window['cancelAnimationFrame'] = window.cancelAnimationFrame;
}
if (/iP(ad|hone|od).*OS 6/.test(window.navigator.userAgent) || !window.requestAnimationFrame || !window.cancelAnimationFrame) {
    var lastTime = 0;
    /**
     * requestAnimationFrame polyfill.
     * @param  {!Function} callback the callback function.
     */
    window.requestAnimationFrame = function (callback) {
        var now = Date.now();
        var nextTime = Math.max(lastTime + 16, now);
        return setTimeout(function () {
            callback(lastTime = nextTime);
        }, nextTime - now);
    };
    window.cancelAnimationFrame = clearTimeout;
    window['requestAnimationFrame'] = window.requestAnimationFrame;
    window['cancelAnimationFrame'] = window.cancelAnimationFrame;
}
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Button MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialButton = function MaterialButton(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialButton'] = MaterialButton;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialButton.prototype.Constant_ = {};
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialButton.prototype.CssClasses_ = {
    RIPPLE_EFFECT: 'mdl-js-ripple-effect',
    RIPPLE_CONTAINER: 'mdl-button__ripple-container',
    RIPPLE: 'mdl-ripple'
};
/**
   * Handle blur of element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialButton.prototype.blurHandler_ = function (event) {
    if (event) {
        this.element_.blur();
    }
};
// Public methods.
/**
   * Disable button.
   *
   * @public
   */
MaterialButton.prototype.disable = function () {
    this.element_.disabled = true;
};
MaterialButton.prototype['disable'] = MaterialButton.prototype.disable;
/**
   * Enable button.
   *
   * @public
   */
MaterialButton.prototype.enable = function () {
    this.element_.disabled = false;
};
MaterialButton.prototype['enable'] = MaterialButton.prototype.enable;
/**
   * Initialize element.
   */
MaterialButton.prototype.init = function () {
    if (this.element_) {
        if (this.element_.classList.contains(this.CssClasses_.RIPPLE_EFFECT)) {
            var rippleContainer = document.createElement('span');
            rippleContainer.classList.add(this.CssClasses_.RIPPLE_CONTAINER);
            this.rippleElement_ = document.createElement('span');
            this.rippleElement_.classList.add(this.CssClasses_.RIPPLE);
            rippleContainer.appendChild(this.rippleElement_);
            this.boundRippleBlurHandler = this.blurHandler_.bind(this);
            this.rippleElement_.addEventListener('mouseup', this.boundRippleBlurHandler);
            this.element_.appendChild(rippleContainer);
        }
        this.boundButtonBlurHandler = this.blurHandler_.bind(this);
        this.element_.addEventListener('mouseup', this.boundButtonBlurHandler);
        this.element_.addEventListener('mouseleave', this.boundButtonBlurHandler);
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialButton,
    classAsString: 'MaterialButton',
    cssClass: 'mdl-js-button',
    widget: true
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Checkbox MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialCheckbox = function MaterialCheckbox(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialCheckbox'] = MaterialCheckbox;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialCheckbox.prototype.Constant_ = { TINY_TIMEOUT: 0.001 };
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialCheckbox.prototype.CssClasses_ = {
    INPUT: 'mdl-checkbox__input',
    BOX_OUTLINE: 'mdl-checkbox__box-outline',
    FOCUS_HELPER: 'mdl-checkbox__focus-helper',
    TICK_OUTLINE: 'mdl-checkbox__tick-outline',
    RIPPLE_EFFECT: 'mdl-js-ripple-effect',
    RIPPLE_IGNORE_EVENTS: 'mdl-js-ripple-effect--ignore-events',
    RIPPLE_CONTAINER: 'mdl-checkbox__ripple-container',
    RIPPLE_CENTER: 'mdl-ripple--center',
    RIPPLE: 'mdl-ripple',
    IS_FOCUSED: 'is-focused',
    IS_DISABLED: 'is-disabled',
    IS_CHECKED: 'is-checked',
    IS_UPGRADED: 'is-upgraded'
};
/**
   * Handle change of state.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialCheckbox.prototype.onChange_ = function (event) {
    this.updateClasses_();
};
/**
   * Handle focus of element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialCheckbox.prototype.onFocus_ = function (event) {
    this.element_.classList.add(this.CssClasses_.IS_FOCUSED);
};
/**
   * Handle lost focus of element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialCheckbox.prototype.onBlur_ = function (event) {
    this.element_.classList.remove(this.CssClasses_.IS_FOCUSED);
};
/**
   * Handle mouseup.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialCheckbox.prototype.onMouseUp_ = function (event) {
    this.blur_();
};
/**
   * Handle class updates.
   *
   * @private
   */
MaterialCheckbox.prototype.updateClasses_ = function () {
    this.checkDisabled();
    this.checkToggleState();
};
/**
   * Add blur.
   *
   * @private
   */
MaterialCheckbox.prototype.blur_ = function () {
    // TODO: figure out why there's a focus event being fired after our blur,
    // so that we can avoid this hack.
    window.setTimeout(function () {
        this.inputElement_.blur();
    }.bind(this), this.Constant_.TINY_TIMEOUT);
};
// Public methods.
/**
   * Check the inputs toggle state and update display.
   *
   * @public
   */
MaterialCheckbox.prototype.checkToggleState = function () {
    if (this.inputElement_.checked) {
        this.element_.classList.add(this.CssClasses_.IS_CHECKED);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_CHECKED);
    }
};
MaterialCheckbox.prototype['checkToggleState'] = MaterialCheckbox.prototype.checkToggleState;
/**
   * Check the inputs disabled state and update display.
   *
   * @public
   */
MaterialCheckbox.prototype.checkDisabled = function () {
    if (this.inputElement_.disabled) {
        this.element_.classList.add(this.CssClasses_.IS_DISABLED);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_DISABLED);
    }
};
MaterialCheckbox.prototype['checkDisabled'] = MaterialCheckbox.prototype.checkDisabled;
/**
   * Disable checkbox.
   *
   * @public
   */
MaterialCheckbox.prototype.disable = function () {
    this.inputElement_.disabled = true;
    this.updateClasses_();
};
MaterialCheckbox.prototype['disable'] = MaterialCheckbox.prototype.disable;
/**
   * Enable checkbox.
   *
   * @public
   */
MaterialCheckbox.prototype.enable = function () {
    this.inputElement_.disabled = false;
    this.updateClasses_();
};
MaterialCheckbox.prototype['enable'] = MaterialCheckbox.prototype.enable;
/**
   * Check checkbox.
   *
   * @public
   */
MaterialCheckbox.prototype.check = function () {
    this.inputElement_.checked = true;
    this.updateClasses_();
};
MaterialCheckbox.prototype['check'] = MaterialCheckbox.prototype.check;
/**
   * Uncheck checkbox.
   *
   * @public
   */
MaterialCheckbox.prototype.uncheck = function () {
    this.inputElement_.checked = false;
    this.updateClasses_();
};
MaterialCheckbox.prototype['uncheck'] = MaterialCheckbox.prototype.uncheck;
/**
   * Initialize element.
   */
MaterialCheckbox.prototype.init = function () {
    if (this.element_) {
        this.inputElement_ = this.element_.querySelector('.' + this.CssClasses_.INPUT);
        var boxOutline = document.createElement('span');
        boxOutline.classList.add(this.CssClasses_.BOX_OUTLINE);
        var tickContainer = document.createElement('span');
        tickContainer.classList.add(this.CssClasses_.FOCUS_HELPER);
        var tickOutline = document.createElement('span');
        tickOutline.classList.add(this.CssClasses_.TICK_OUTLINE);
        boxOutline.appendChild(tickOutline);
        this.element_.appendChild(tickContainer);
        this.element_.appendChild(boxOutline);
        if (this.element_.classList.contains(this.CssClasses_.RIPPLE_EFFECT)) {
            this.element_.classList.add(this.CssClasses_.RIPPLE_IGNORE_EVENTS);
            this.rippleContainerElement_ = document.createElement('span');
            this.rippleContainerElement_.classList.add(this.CssClasses_.RIPPLE_CONTAINER);
            this.rippleContainerElement_.classList.add(this.CssClasses_.RIPPLE_EFFECT);
            this.rippleContainerElement_.classList.add(this.CssClasses_.RIPPLE_CENTER);
            this.boundRippleMouseUp = this.onMouseUp_.bind(this);
            this.rippleContainerElement_.addEventListener('mouseup', this.boundRippleMouseUp);
            var ripple = document.createElement('span');
            ripple.classList.add(this.CssClasses_.RIPPLE);
            this.rippleContainerElement_.appendChild(ripple);
            this.element_.appendChild(this.rippleContainerElement_);
        }
        this.boundInputOnChange = this.onChange_.bind(this);
        this.boundInputOnFocus = this.onFocus_.bind(this);
        this.boundInputOnBlur = this.onBlur_.bind(this);
        this.boundElementMouseUp = this.onMouseUp_.bind(this);
        this.inputElement_.addEventListener('change', this.boundInputOnChange);
        this.inputElement_.addEventListener('focus', this.boundInputOnFocus);
        this.inputElement_.addEventListener('blur', this.boundInputOnBlur);
        this.element_.addEventListener('mouseup', this.boundElementMouseUp);
        this.updateClasses_();
        this.element_.classList.add(this.CssClasses_.IS_UPGRADED);
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialCheckbox,
    classAsString: 'MaterialCheckbox',
    cssClass: 'mdl-js-checkbox',
    widget: true
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for icon toggle MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialIconToggle = function MaterialIconToggle(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialIconToggle'] = MaterialIconToggle;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialIconToggle.prototype.Constant_ = { TINY_TIMEOUT: 0.001 };
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialIconToggle.prototype.CssClasses_ = {
    INPUT: 'mdl-icon-toggle__input',
    JS_RIPPLE_EFFECT: 'mdl-js-ripple-effect',
    RIPPLE_IGNORE_EVENTS: 'mdl-js-ripple-effect--ignore-events',
    RIPPLE_CONTAINER: 'mdl-icon-toggle__ripple-container',
    RIPPLE_CENTER: 'mdl-ripple--center',
    RIPPLE: 'mdl-ripple',
    IS_FOCUSED: 'is-focused',
    IS_DISABLED: 'is-disabled',
    IS_CHECKED: 'is-checked'
};
/**
   * Handle change of state.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialIconToggle.prototype.onChange_ = function (event) {
    this.updateClasses_();
};
/**
   * Handle focus of element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialIconToggle.prototype.onFocus_ = function (event) {
    this.element_.classList.add(this.CssClasses_.IS_FOCUSED);
};
/**
   * Handle lost focus of element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialIconToggle.prototype.onBlur_ = function (event) {
    this.element_.classList.remove(this.CssClasses_.IS_FOCUSED);
};
/**
   * Handle mouseup.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialIconToggle.prototype.onMouseUp_ = function (event) {
    this.blur_();
};
/**
   * Handle class updates.
   *
   * @private
   */
MaterialIconToggle.prototype.updateClasses_ = function () {
    this.checkDisabled();
    this.checkToggleState();
};
/**
   * Add blur.
   *
   * @private
   */
MaterialIconToggle.prototype.blur_ = function () {
    // TODO: figure out why there's a focus event being fired after our blur,
    // so that we can avoid this hack.
    window.setTimeout(function () {
        this.inputElement_.blur();
    }.bind(this), this.Constant_.TINY_TIMEOUT);
};
// Public methods.
/**
   * Check the inputs toggle state and update display.
   *
   * @public
   */
MaterialIconToggle.prototype.checkToggleState = function () {
    if (this.inputElement_.checked) {
        this.element_.classList.add(this.CssClasses_.IS_CHECKED);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_CHECKED);
    }
};
MaterialIconToggle.prototype['checkToggleState'] = MaterialIconToggle.prototype.checkToggleState;
/**
   * Check the inputs disabled state and update display.
   *
   * @public
   */
MaterialIconToggle.prototype.checkDisabled = function () {
    if (this.inputElement_.disabled) {
        this.element_.classList.add(this.CssClasses_.IS_DISABLED);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_DISABLED);
    }
};
MaterialIconToggle.prototype['checkDisabled'] = MaterialIconToggle.prototype.checkDisabled;
/**
   * Disable icon toggle.
   *
   * @public
   */
MaterialIconToggle.prototype.disable = function () {
    this.inputElement_.disabled = true;
    this.updateClasses_();
};
MaterialIconToggle.prototype['disable'] = MaterialIconToggle.prototype.disable;
/**
   * Enable icon toggle.
   *
   * @public
   */
MaterialIconToggle.prototype.enable = function () {
    this.inputElement_.disabled = false;
    this.updateClasses_();
};
MaterialIconToggle.prototype['enable'] = MaterialIconToggle.prototype.enable;
/**
   * Check icon toggle.
   *
   * @public
   */
MaterialIconToggle.prototype.check = function () {
    this.inputElement_.checked = true;
    this.updateClasses_();
};
MaterialIconToggle.prototype['check'] = MaterialIconToggle.prototype.check;
/**
   * Uncheck icon toggle.
   *
   * @public
   */
MaterialIconToggle.prototype.uncheck = function () {
    this.inputElement_.checked = false;
    this.updateClasses_();
};
MaterialIconToggle.prototype['uncheck'] = MaterialIconToggle.prototype.uncheck;
/**
   * Initialize element.
   */
MaterialIconToggle.prototype.init = function () {
    if (this.element_) {
        this.inputElement_ = this.element_.querySelector('.' + this.CssClasses_.INPUT);
        if (this.element_.classList.contains(this.CssClasses_.JS_RIPPLE_EFFECT)) {
            this.element_.classList.add(this.CssClasses_.RIPPLE_IGNORE_EVENTS);
            this.rippleContainerElement_ = document.createElement('span');
            this.rippleContainerElement_.classList.add(this.CssClasses_.RIPPLE_CONTAINER);
            this.rippleContainerElement_.classList.add(this.CssClasses_.JS_RIPPLE_EFFECT);
            this.rippleContainerElement_.classList.add(this.CssClasses_.RIPPLE_CENTER);
            this.boundRippleMouseUp = this.onMouseUp_.bind(this);
            this.rippleContainerElement_.addEventListener('mouseup', this.boundRippleMouseUp);
            var ripple = document.createElement('span');
            ripple.classList.add(this.CssClasses_.RIPPLE);
            this.rippleContainerElement_.appendChild(ripple);
            this.element_.appendChild(this.rippleContainerElement_);
        }
        this.boundInputOnChange = this.onChange_.bind(this);
        this.boundInputOnFocus = this.onFocus_.bind(this);
        this.boundInputOnBlur = this.onBlur_.bind(this);
        this.boundElementOnMouseUp = this.onMouseUp_.bind(this);
        this.inputElement_.addEventListener('change', this.boundInputOnChange);
        this.inputElement_.addEventListener('focus', this.boundInputOnFocus);
        this.inputElement_.addEventListener('blur', this.boundInputOnBlur);
        this.element_.addEventListener('mouseup', this.boundElementOnMouseUp);
        this.updateClasses_();
        this.element_.classList.add('is-upgraded');
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialIconToggle,
    classAsString: 'MaterialIconToggle',
    cssClass: 'mdl-js-icon-toggle',
    widget: true
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for dropdown MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialMenu = function MaterialMenu(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialMenu'] = MaterialMenu;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialMenu.prototype.Constant_ = {
    // Total duration of the menu animation.
    TRANSITION_DURATION_SECONDS: 0.3,
    // The fraction of the total duration we want to use for menu item animations.
    TRANSITION_DURATION_FRACTION: 0.8,
    // How long the menu stays open after choosing an option (so the user can see
    // the ripple).
    CLOSE_TIMEOUT: 150
};
/**
   * Keycodes, for code readability.
   *
   * @enum {number}
   * @private
   */
MaterialMenu.prototype.Keycodes_ = {
    ENTER: 13,
    ESCAPE: 27,
    SPACE: 32,
    UP_ARROW: 38,
    DOWN_ARROW: 40
};
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialMenu.prototype.CssClasses_ = {
    CONTAINER: 'mdl-menu__container',
    OUTLINE: 'mdl-menu__outline',
    ITEM: 'mdl-menu__item',
    ITEM_RIPPLE_CONTAINER: 'mdl-menu__item-ripple-container',
    RIPPLE_EFFECT: 'mdl-js-ripple-effect',
    RIPPLE_IGNORE_EVENTS: 'mdl-js-ripple-effect--ignore-events',
    RIPPLE: 'mdl-ripple',
    // Statuses
    IS_UPGRADED: 'is-upgraded',
    IS_VISIBLE: 'is-visible',
    IS_ANIMATING: 'is-animating',
    // Alignment options
    BOTTOM_LEFT: 'mdl-menu--bottom-left',
    // This is the default.
    BOTTOM_RIGHT: 'mdl-menu--bottom-right',
    TOP_LEFT: 'mdl-menu--top-left',
    TOP_RIGHT: 'mdl-menu--top-right',
    UNALIGNED: 'mdl-menu--unaligned'
};
/**
   * Initialize element.
   */
MaterialMenu.prototype.init = function () {
    if (this.element_) {
        // Create container for the menu.
        var container = document.createElement('div');
        container.classList.add(this.CssClasses_.CONTAINER);
        this.element_.parentElement.insertBefore(container, this.element_);
        this.element_.parentElement.removeChild(this.element_);
        container.appendChild(this.element_);
        this.container_ = container;
        // Create outline for the menu (shadow and background).
        var outline = document.createElement('div');
        outline.classList.add(this.CssClasses_.OUTLINE);
        this.outline_ = outline;
        container.insertBefore(outline, this.element_);
        // Find the "for" element and bind events to it.
        var forElId = this.element_.getAttribute('for') || this.element_.getAttribute('data-mdl-for');
        var forEl = null;
        if (forElId) {
            forEl = document.getElementById(forElId);
            if (forEl) {
                this.forElement_ = forEl;
                forEl.addEventListener('click', this.handleForClick_.bind(this));
                forEl.addEventListener('keydown', this.handleForKeyboardEvent_.bind(this));
            }
        }
        var items = this.element_.querySelectorAll('.' + this.CssClasses_.ITEM);
        this.boundItemKeydown_ = this.handleItemKeyboardEvent_.bind(this);
        this.boundItemClick_ = this.handleItemClick_.bind(this);
        for (var i = 0; i < items.length; i++) {
            // Add a listener to each menu item.
            items[i].addEventListener('click', this.boundItemClick_);
            // Add a tab index to each menu item.
            items[i].tabIndex = '-1';
            // Add a keyboard listener to each menu item.
            items[i].addEventListener('keydown', this.boundItemKeydown_);
        }
        // Add ripple classes to each item, if the user has enabled ripples.
        if (this.element_.classList.contains(this.CssClasses_.RIPPLE_EFFECT)) {
            this.element_.classList.add(this.CssClasses_.RIPPLE_IGNORE_EVENTS);
            for (i = 0; i < items.length; i++) {
                var item = items[i];
                var rippleContainer = document.createElement('span');
                rippleContainer.classList.add(this.CssClasses_.ITEM_RIPPLE_CONTAINER);
                var ripple = document.createElement('span');
                ripple.classList.add(this.CssClasses_.RIPPLE);
                rippleContainer.appendChild(ripple);
                item.appendChild(rippleContainer);
                item.classList.add(this.CssClasses_.RIPPLE_EFFECT);
            }
        }
        // Copy alignment classes to the container, so the outline can use them.
        if (this.element_.classList.contains(this.CssClasses_.BOTTOM_LEFT)) {
            this.outline_.classList.add(this.CssClasses_.BOTTOM_LEFT);
        }
        if (this.element_.classList.contains(this.CssClasses_.BOTTOM_RIGHT)) {
            this.outline_.classList.add(this.CssClasses_.BOTTOM_RIGHT);
        }
        if (this.element_.classList.contains(this.CssClasses_.TOP_LEFT)) {
            this.outline_.classList.add(this.CssClasses_.TOP_LEFT);
        }
        if (this.element_.classList.contains(this.CssClasses_.TOP_RIGHT)) {
            this.outline_.classList.add(this.CssClasses_.TOP_RIGHT);
        }
        if (this.element_.classList.contains(this.CssClasses_.UNALIGNED)) {
            this.outline_.classList.add(this.CssClasses_.UNALIGNED);
        }
        container.classList.add(this.CssClasses_.IS_UPGRADED);
    }
};
/**
   * Handles a click on the "for" element, by positioning the menu and then
   * toggling it.
   *
   * @param {Event} evt The event that fired.
   * @private
   */
MaterialMenu.prototype.handleForClick_ = function (evt) {
    if (this.element_ && this.forElement_) {
        var rect = this.forElement_.getBoundingClientRect();
        var forRect = this.forElement_.parentElement.getBoundingClientRect();
        if (this.element_.classList.contains(this.CssClasses_.UNALIGNED)) {
        } else if (this.element_.classList.contains(this.CssClasses_.BOTTOM_RIGHT)) {
            // Position below the "for" element, aligned to its right.
            this.container_.style.right = forRect.right - rect.right + 'px';
            this.container_.style.top = this.forElement_.offsetTop + this.forElement_.offsetHeight + 'px';
        } else if (this.element_.classList.contains(this.CssClasses_.TOP_LEFT)) {
            // Position above the "for" element, aligned to its left.
            this.container_.style.left = this.forElement_.offsetLeft + 'px';
            this.container_.style.bottom = forRect.bottom - rect.top + 'px';
        } else if (this.element_.classList.contains(this.CssClasses_.TOP_RIGHT)) {
            // Position above the "for" element, aligned to its right.
            this.container_.style.right = forRect.right - rect.right + 'px';
            this.container_.style.bottom = forRect.bottom - rect.top + 'px';
        } else {
            // Default: position below the "for" element, aligned to its left.
            this.container_.style.left = this.forElement_.offsetLeft + 'px';
            this.container_.style.top = this.forElement_.offsetTop + this.forElement_.offsetHeight + 'px';
        }
    }
    this.toggle(evt);
};
/**
   * Handles a keyboard event on the "for" element.
   *
   * @param {Event} evt The event that fired.
   * @private
   */
MaterialMenu.prototype.handleForKeyboardEvent_ = function (evt) {
    if (this.element_ && this.container_ && this.forElement_) {
        var items = this.element_.querySelectorAll('.' + this.CssClasses_.ITEM + ':not([disabled])');
        if (items && items.length > 0 && this.container_.classList.contains(this.CssClasses_.IS_VISIBLE)) {
            if (evt.keyCode === this.Keycodes_.UP_ARROW) {
                evt.preventDefault();
                items[items.length - 1].focus();
            } else if (evt.keyCode === this.Keycodes_.DOWN_ARROW) {
                evt.preventDefault();
                items[0].focus();
            }
        }
    }
};
/**
   * Handles a keyboard event on an item.
   *
   * @param {Event} evt The event that fired.
   * @private
   */
MaterialMenu.prototype.handleItemKeyboardEvent_ = function (evt) {
    if (this.element_ && this.container_) {
        var items = this.element_.querySelectorAll('.' + this.CssClasses_.ITEM + ':not([disabled])');
        if (items && items.length > 0 && this.container_.classList.contains(this.CssClasses_.IS_VISIBLE)) {
            var currentIndex = Array.prototype.slice.call(items).indexOf(evt.target);
            if (evt.keyCode === this.Keycodes_.UP_ARROW) {
                evt.preventDefault();
                if (currentIndex > 0) {
                    items[currentIndex - 1].focus();
                } else {
                    items[items.length - 1].focus();
                }
            } else if (evt.keyCode === this.Keycodes_.DOWN_ARROW) {
                evt.preventDefault();
                if (items.length > currentIndex + 1) {
                    items[currentIndex + 1].focus();
                } else {
                    items[0].focus();
                }
            } else if (evt.keyCode === this.Keycodes_.SPACE || evt.keyCode === this.Keycodes_.ENTER) {
                evt.preventDefault();
                // Send mousedown and mouseup to trigger ripple.
                var e = new MouseEvent('mousedown');
                evt.target.dispatchEvent(e);
                e = new MouseEvent('mouseup');
                evt.target.dispatchEvent(e);
                // Send click.
                evt.target.click();
            } else if (evt.keyCode === this.Keycodes_.ESCAPE) {
                evt.preventDefault();
                this.hide();
            }
        }
    }
};
/**
   * Handles a click event on an item.
   *
   * @param {Event} evt The event that fired.
   * @private
   */
MaterialMenu.prototype.handleItemClick_ = function (evt) {
    if (evt.target.hasAttribute('disabled')) {
        evt.stopPropagation();
    } else {
        // Wait some time before closing menu, so the user can see the ripple.
        this.closing_ = true;
        window.setTimeout(function (evt) {
            this.hide();
            this.closing_ = false;
        }.bind(this), this.Constant_.CLOSE_TIMEOUT);
    }
};
/**
   * Calculates the initial clip (for opening the menu) or final clip (for closing
   * it), and applies it. This allows us to animate from or to the correct point,
   * that is, the point it's aligned to in the "for" element.
   *
   * @param {number} height Height of the clip rectangle
   * @param {number} width Width of the clip rectangle
   * @private
   */
MaterialMenu.prototype.applyClip_ = function (height, width) {
    if (this.element_.classList.contains(this.CssClasses_.UNALIGNED)) {
        // Do not clip.
        this.element_.style.clip = '';
    } else if (this.element_.classList.contains(this.CssClasses_.BOTTOM_RIGHT)) {
        // Clip to the top right corner of the menu.
        this.element_.style.clip = 'rect(0 ' + width + 'px ' + '0 ' + width + 'px)';
    } else if (this.element_.classList.contains(this.CssClasses_.TOP_LEFT)) {
        // Clip to the bottom left corner of the menu.
        this.element_.style.clip = 'rect(' + height + 'px 0 ' + height + 'px 0)';
    } else if (this.element_.classList.contains(this.CssClasses_.TOP_RIGHT)) {
        // Clip to the bottom right corner of the menu.
        this.element_.style.clip = 'rect(' + height + 'px ' + width + 'px ' + height + 'px ' + width + 'px)';
    } else {
        // Default: do not clip (same as clipping to the top left corner).
        this.element_.style.clip = '';
    }
};
/**
   * Cleanup function to remove animation listeners.
   *
   * @param {Event} evt
   * @private
   */
MaterialMenu.prototype.removeAnimationEndListener_ = function (evt) {
    evt.target.classList.remove(MaterialMenu.prototype.CssClasses_.IS_ANIMATING);
};
/**
   * Adds an event listener to clean up after the animation ends.
   *
   * @private
   */
MaterialMenu.prototype.addAnimationEndListener_ = function () {
    this.element_.addEventListener('transitionend', this.removeAnimationEndListener_);
    this.element_.addEventListener('webkitTransitionEnd', this.removeAnimationEndListener_);
};
/**
   * Displays the menu.
   *
   * @public
   */
MaterialMenu.prototype.show = function (evt) {
    if (this.element_ && this.container_ && this.outline_) {
        // Measure the inner element.
        var height = this.element_.getBoundingClientRect().height;
        var width = this.element_.getBoundingClientRect().width;
        // Apply the inner element's size to the container and outline.
        this.container_.style.width = width + 'px';
        this.container_.style.height = height + 'px';
        this.outline_.style.width = width + 'px';
        this.outline_.style.height = height + 'px';
        var transitionDuration = this.Constant_.TRANSITION_DURATION_SECONDS * this.Constant_.TRANSITION_DURATION_FRACTION;
        // Calculate transition delays for individual menu items, so that they fade
        // in one at a time.
        var items = this.element_.querySelectorAll('.' + this.CssClasses_.ITEM);
        for (var i = 0; i < items.length; i++) {
            var itemDelay = null;
            if (this.element_.classList.contains(this.CssClasses_.TOP_LEFT) || this.element_.classList.contains(this.CssClasses_.TOP_RIGHT)) {
                itemDelay = (height - items[i].offsetTop - items[i].offsetHeight) / height * transitionDuration + 's';
            } else {
                itemDelay = items[i].offsetTop / height * transitionDuration + 's';
            }
            items[i].style.transitionDelay = itemDelay;
        }
        // Apply the initial clip to the text before we start animating.
        this.applyClip_(height, width);
        // Wait for the next frame, turn on animation, and apply the final clip.
        // Also make it visible. This triggers the transitions.
        window.requestAnimationFrame(function () {
            this.element_.classList.add(this.CssClasses_.IS_ANIMATING);
            this.element_.style.clip = 'rect(0 ' + width + 'px ' + height + 'px 0)';
            this.container_.classList.add(this.CssClasses_.IS_VISIBLE);
        }.bind(this));
        // Clean up after the animation is complete.
        this.addAnimationEndListener_();
        // Add a click listener to the document, to close the menu.
        var callback = function (e) {
            // Check to see if the document is processing the same event that
            // displayed the menu in the first place. If so, do nothing.
            // Also check to see if the menu is in the process of closing itself, and
            // do nothing in that case.
            // Also check if the clicked element is a menu item
            // if so, do nothing.
            if (e !== evt && !this.closing_ && e.target.parentNode !== this.element_) {
                document.removeEventListener('click', callback);
                this.hide();
            }
        }.bind(this);
        document.addEventListener('click', callback);
    }
};
MaterialMenu.prototype['show'] = MaterialMenu.prototype.show;
/**
   * Hides the menu.
   *
   * @public
   */
MaterialMenu.prototype.hide = function () {
    if (this.element_ && this.container_ && this.outline_) {
        var items = this.element_.querySelectorAll('.' + this.CssClasses_.ITEM);
        // Remove all transition delays; menu items fade out concurrently.
        for (var i = 0; i < items.length; i++) {
            items[i].style.removeProperty('transition-delay');
        }
        // Measure the inner element.
        var rect = this.element_.getBoundingClientRect();
        var height = rect.height;
        var width = rect.width;
        // Turn on animation, and apply the final clip. Also make invisible.
        // This triggers the transitions.
        this.element_.classList.add(this.CssClasses_.IS_ANIMATING);
        this.applyClip_(height, width);
        this.container_.classList.remove(this.CssClasses_.IS_VISIBLE);
        // Clean up after the animation is complete.
        this.addAnimationEndListener_();
    }
};
MaterialMenu.prototype['hide'] = MaterialMenu.prototype.hide;
/**
   * Displays or hides the menu, depending on current state.
   *
   * @public
   */
MaterialMenu.prototype.toggle = function (evt) {
    if (this.container_.classList.contains(this.CssClasses_.IS_VISIBLE)) {
        this.hide();
    } else {
        this.show(evt);
    }
};
MaterialMenu.prototype['toggle'] = MaterialMenu.prototype.toggle;
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialMenu,
    classAsString: 'MaterialMenu',
    cssClass: 'mdl-js-menu',
    widget: true
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Progress MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialProgress = function MaterialProgress(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialProgress'] = MaterialProgress;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialProgress.prototype.Constant_ = {};
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialProgress.prototype.CssClasses_ = { INDETERMINATE_CLASS: 'mdl-progress__indeterminate' };
/**
   * Set the current progress of the progressbar.
   *
   * @param {number} p Percentage of the progress (0-100)
   * @public
   */
MaterialProgress.prototype.setProgress = function (p) {
    if (this.element_.classList.contains(this.CssClasses_.INDETERMINATE_CLASS)) {
        return;
    }
    this.progressbar_.style.width = p + '%';
};
MaterialProgress.prototype['setProgress'] = MaterialProgress.prototype.setProgress;
/**
   * Set the current progress of the buffer.
   *
   * @param {number} p Percentage of the buffer (0-100)
   * @public
   */
MaterialProgress.prototype.setBuffer = function (p) {
    this.bufferbar_.style.width = p + '%';
    this.auxbar_.style.width = 100 - p + '%';
};
MaterialProgress.prototype['setBuffer'] = MaterialProgress.prototype.setBuffer;
/**
   * Initialize element.
   */
MaterialProgress.prototype.init = function () {
    if (this.element_) {
        var el = document.createElement('div');
        el.className = 'progressbar bar bar1';
        this.element_.appendChild(el);
        this.progressbar_ = el;
        el = document.createElement('div');
        el.className = 'bufferbar bar bar2';
        this.element_.appendChild(el);
        this.bufferbar_ = el;
        el = document.createElement('div');
        el.className = 'auxbar bar bar3';
        this.element_.appendChild(el);
        this.auxbar_ = el;
        this.progressbar_.style.width = '0%';
        this.bufferbar_.style.width = '100%';
        this.auxbar_.style.width = '0%';
        this.element_.classList.add('is-upgraded');
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialProgress,
    classAsString: 'MaterialProgress',
    cssClass: 'mdl-js-progress',
    widget: true
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Radio MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialRadio = function MaterialRadio(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialRadio'] = MaterialRadio;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialRadio.prototype.Constant_ = { TINY_TIMEOUT: 0.001 };
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialRadio.prototype.CssClasses_ = {
    IS_FOCUSED: 'is-focused',
    IS_DISABLED: 'is-disabled',
    IS_CHECKED: 'is-checked',
    IS_UPGRADED: 'is-upgraded',
    JS_RADIO: 'mdl-js-radio',
    RADIO_BTN: 'mdl-radio__button',
    RADIO_OUTER_CIRCLE: 'mdl-radio__outer-circle',
    RADIO_INNER_CIRCLE: 'mdl-radio__inner-circle',
    RIPPLE_EFFECT: 'mdl-js-ripple-effect',
    RIPPLE_IGNORE_EVENTS: 'mdl-js-ripple-effect--ignore-events',
    RIPPLE_CONTAINER: 'mdl-radio__ripple-container',
    RIPPLE_CENTER: 'mdl-ripple--center',
    RIPPLE: 'mdl-ripple'
};
/**
   * Handle change of state.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialRadio.prototype.onChange_ = function (event) {
    // Since other radio buttons don't get change events, we need to look for
    // them to update their classes.
    var radios = document.getElementsByClassName(this.CssClasses_.JS_RADIO);
    for (var i = 0; i < radios.length; i++) {
        var button = radios[i].querySelector('.' + this.CssClasses_.RADIO_BTN);
        // Different name == different group, so no point updating those.
        if (button.getAttribute('name') === this.btnElement_.getAttribute('name')) {
            if (typeof radios[i]['MaterialRadio'] !== 'undefined') {
                radios[i]['MaterialRadio'].updateClasses_();
            }
        }
    }
};
/**
   * Handle focus.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialRadio.prototype.onFocus_ = function (event) {
    this.element_.classList.add(this.CssClasses_.IS_FOCUSED);
};
/**
   * Handle lost focus.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialRadio.prototype.onBlur_ = function (event) {
    this.element_.classList.remove(this.CssClasses_.IS_FOCUSED);
};
/**
   * Handle mouseup.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialRadio.prototype.onMouseup_ = function (event) {
    this.blur_();
};
/**
   * Update classes.
   *
   * @private
   */
MaterialRadio.prototype.updateClasses_ = function () {
    this.checkDisabled();
    this.checkToggleState();
};
/**
   * Add blur.
   *
   * @private
   */
MaterialRadio.prototype.blur_ = function () {
    // TODO: figure out why there's a focus event being fired after our blur,
    // so that we can avoid this hack.
    window.setTimeout(function () {
        this.btnElement_.blur();
    }.bind(this), this.Constant_.TINY_TIMEOUT);
};
// Public methods.
/**
   * Check the components disabled state.
   *
   * @public
   */
MaterialRadio.prototype.checkDisabled = function () {
    if (this.btnElement_.disabled) {
        this.element_.classList.add(this.CssClasses_.IS_DISABLED);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_DISABLED);
    }
};
MaterialRadio.prototype['checkDisabled'] = MaterialRadio.prototype.checkDisabled;
/**
   * Check the components toggled state.
   *
   * @public
   */
MaterialRadio.prototype.checkToggleState = function () {
    if (this.btnElement_.checked) {
        this.element_.classList.add(this.CssClasses_.IS_CHECKED);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_CHECKED);
    }
};
MaterialRadio.prototype['checkToggleState'] = MaterialRadio.prototype.checkToggleState;
/**
   * Disable radio.
   *
   * @public
   */
MaterialRadio.prototype.disable = function () {
    this.btnElement_.disabled = true;
    this.updateClasses_();
};
MaterialRadio.prototype['disable'] = MaterialRadio.prototype.disable;
/**
   * Enable radio.
   *
   * @public
   */
MaterialRadio.prototype.enable = function () {
    this.btnElement_.disabled = false;
    this.updateClasses_();
};
MaterialRadio.prototype['enable'] = MaterialRadio.prototype.enable;
/**
   * Check radio.
   *
   * @public
   */
MaterialRadio.prototype.check = function () {
    this.btnElement_.checked = true;
    this.onChange_(null);
};
MaterialRadio.prototype['check'] = MaterialRadio.prototype.check;
/**
   * Uncheck radio.
   *
   * @public
   */
MaterialRadio.prototype.uncheck = function () {
    this.btnElement_.checked = false;
    this.onChange_(null);
};
MaterialRadio.prototype['uncheck'] = MaterialRadio.prototype.uncheck;
/**
   * Initialize element.
   */
MaterialRadio.prototype.init = function () {
    if (this.element_) {
        this.btnElement_ = this.element_.querySelector('.' + this.CssClasses_.RADIO_BTN);
        this.boundChangeHandler_ = this.onChange_.bind(this);
        this.boundFocusHandler_ = this.onChange_.bind(this);
        this.boundBlurHandler_ = this.onBlur_.bind(this);
        this.boundMouseUpHandler_ = this.onMouseup_.bind(this);
        var outerCircle = document.createElement('span');
        outerCircle.classList.add(this.CssClasses_.RADIO_OUTER_CIRCLE);
        var innerCircle = document.createElement('span');
        innerCircle.classList.add(this.CssClasses_.RADIO_INNER_CIRCLE);
        this.element_.appendChild(outerCircle);
        this.element_.appendChild(innerCircle);
        var rippleContainer;
        if (this.element_.classList.contains(this.CssClasses_.RIPPLE_EFFECT)) {
            this.element_.classList.add(this.CssClasses_.RIPPLE_IGNORE_EVENTS);
            rippleContainer = document.createElement('span');
            rippleContainer.classList.add(this.CssClasses_.RIPPLE_CONTAINER);
            rippleContainer.classList.add(this.CssClasses_.RIPPLE_EFFECT);
            rippleContainer.classList.add(this.CssClasses_.RIPPLE_CENTER);
            rippleContainer.addEventListener('mouseup', this.boundMouseUpHandler_);
            var ripple = document.createElement('span');
            ripple.classList.add(this.CssClasses_.RIPPLE);
            rippleContainer.appendChild(ripple);
            this.element_.appendChild(rippleContainer);
        }
        this.btnElement_.addEventListener('change', this.boundChangeHandler_);
        this.btnElement_.addEventListener('focus', this.boundFocusHandler_);
        this.btnElement_.addEventListener('blur', this.boundBlurHandler_);
        this.element_.addEventListener('mouseup', this.boundMouseUpHandler_);
        this.updateClasses_();
        this.element_.classList.add(this.CssClasses_.IS_UPGRADED);
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialRadio,
    classAsString: 'MaterialRadio',
    cssClass: 'mdl-js-radio',
    widget: true
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Slider MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialSlider = function MaterialSlider(element) {
    this.element_ = element;
    // Browser feature detection.
    this.isIE_ = window.navigator.msPointerEnabled;
    // Initialize instance.
    this.init();
};
window['MaterialSlider'] = MaterialSlider;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialSlider.prototype.Constant_ = {};
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialSlider.prototype.CssClasses_ = {
    IE_CONTAINER: 'mdl-slider__ie-container',
    SLIDER_CONTAINER: 'mdl-slider__container',
    BACKGROUND_FLEX: 'mdl-slider__background-flex',
    BACKGROUND_LOWER: 'mdl-slider__background-lower',
    BACKGROUND_UPPER: 'mdl-slider__background-upper',
    IS_LOWEST_VALUE: 'is-lowest-value',
    IS_UPGRADED: 'is-upgraded'
};
/**
   * Handle input on element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialSlider.prototype.onInput_ = function (event) {
    this.updateValueStyles_();
};
/**
   * Handle change on element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialSlider.prototype.onChange_ = function (event) {
    this.updateValueStyles_();
};
/**
   * Handle mouseup on element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialSlider.prototype.onMouseUp_ = function (event) {
    event.target.blur();
};
/**
   * Handle mousedown on container element.
   * This handler is purpose is to not require the use to click
   * exactly on the 2px slider element, as FireFox seems to be very
   * strict about this.
   *
   * @param {Event} event The event that fired.
   * @private
   * @suppress {missingProperties}
   */
MaterialSlider.prototype.onContainerMouseDown_ = function (event) {
    // If this click is not on the parent element (but rather some child)
    // ignore. It may still bubble up.
    if (event.target !== this.element_.parentElement) {
        return;
    }
    // Discard the original event and create a new event that
    // is on the slider element.
    event.preventDefault();
    var newEvent = new MouseEvent('mousedown', {
        target: event.target,
        buttons: event.buttons,
        clientX: event.clientX,
        clientY: this.element_.getBoundingClientRect().y
    });
    this.element_.dispatchEvent(newEvent);
};
/**
   * Handle updating of values.
   *
   * @private
   */
MaterialSlider.prototype.updateValueStyles_ = function () {
    // Calculate and apply percentages to div structure behind slider.
    var fraction = (this.element_.value - this.element_.min) / (this.element_.max - this.element_.min);
    if (fraction === 0) {
        this.element_.classList.add(this.CssClasses_.IS_LOWEST_VALUE);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_LOWEST_VALUE);
    }
    if (!this.isIE_) {
        this.backgroundLower_.style.flex = fraction;
        this.backgroundLower_.style.webkitFlex = fraction;
        this.backgroundUpper_.style.flex = 1 - fraction;
        this.backgroundUpper_.style.webkitFlex = 1 - fraction;
    }
};
// Public methods.
/**
   * Disable slider.
   *
   * @public
   */
MaterialSlider.prototype.disable = function () {
    this.element_.disabled = true;
};
MaterialSlider.prototype['disable'] = MaterialSlider.prototype.disable;
/**
   * Enable slider.
   *
   * @public
   */
MaterialSlider.prototype.enable = function () {
    this.element_.disabled = false;
};
MaterialSlider.prototype['enable'] = MaterialSlider.prototype.enable;
/**
   * Update slider value.
   *
   * @param {number} value The value to which to set the control (optional).
   * @public
   */
MaterialSlider.prototype.change = function (value) {
    if (typeof value !== 'undefined') {
        this.element_.value = value;
    }
    this.updateValueStyles_();
};
MaterialSlider.prototype['change'] = MaterialSlider.prototype.change;
/**
   * Initialize element.
   */
MaterialSlider.prototype.init = function () {
    if (this.element_) {
        if (this.isIE_) {
            // Since we need to specify a very large height in IE due to
            // implementation limitations, we add a parent here that trims it down to
            // a reasonable size.
            var containerIE = document.createElement('div');
            containerIE.classList.add(this.CssClasses_.IE_CONTAINER);
            this.element_.parentElement.insertBefore(containerIE, this.element_);
            this.element_.parentElement.removeChild(this.element_);
            containerIE.appendChild(this.element_);
        } else {
            // For non-IE browsers, we need a div structure that sits behind the
            // slider and allows us to style the left and right sides of it with
            // different colors.
            var container = document.createElement('div');
            container.classList.add(this.CssClasses_.SLIDER_CONTAINER);
            this.element_.parentElement.insertBefore(container, this.element_);
            this.element_.parentElement.removeChild(this.element_);
            container.appendChild(this.element_);
            var backgroundFlex = document.createElement('div');
            backgroundFlex.classList.add(this.CssClasses_.BACKGROUND_FLEX);
            container.appendChild(backgroundFlex);
            this.backgroundLower_ = document.createElement('div');
            this.backgroundLower_.classList.add(this.CssClasses_.BACKGROUND_LOWER);
            backgroundFlex.appendChild(this.backgroundLower_);
            this.backgroundUpper_ = document.createElement('div');
            this.backgroundUpper_.classList.add(this.CssClasses_.BACKGROUND_UPPER);
            backgroundFlex.appendChild(this.backgroundUpper_);
        }
        this.boundInputHandler = this.onInput_.bind(this);
        this.boundChangeHandler = this.onChange_.bind(this);
        this.boundMouseUpHandler = this.onMouseUp_.bind(this);
        this.boundContainerMouseDownHandler = this.onContainerMouseDown_.bind(this);
        this.element_.addEventListener('input', this.boundInputHandler);
        this.element_.addEventListener('change', this.boundChangeHandler);
        this.element_.addEventListener('mouseup', this.boundMouseUpHandler);
        this.element_.parentElement.addEventListener('mousedown', this.boundContainerMouseDownHandler);
        this.updateValueStyles_();
        this.element_.classList.add(this.CssClasses_.IS_UPGRADED);
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialSlider,
    classAsString: 'MaterialSlider',
    cssClass: 'mdl-js-slider',
    widget: true
});
/**
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Snackbar MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialSnackbar = function MaterialSnackbar(element) {
    this.element_ = element;
    this.textElement_ = this.element_.querySelector('.' + this.cssClasses_.MESSAGE);
    this.actionElement_ = this.element_.querySelector('.' + this.cssClasses_.ACTION);
    if (!this.textElement_) {
        throw new Error('There must be a message element for a snackbar.');
    }
    if (!this.actionElement_) {
        throw new Error('There must be an action element for a snackbar.');
    }
    this.active = false;
    this.actionHandler_ = undefined;
    this.message_ = undefined;
    this.actionText_ = undefined;
    this.queuedNotifications_ = [];
    this.setActionHidden_(true);
};
window['MaterialSnackbar'] = MaterialSnackbar;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialSnackbar.prototype.Constant_ = {
    // The duration of the snackbar show/hide animation, in ms.
    ANIMATION_LENGTH: 250
};
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialSnackbar.prototype.cssClasses_ = {
    SNACKBAR: 'mdl-snackbar',
    MESSAGE: 'mdl-snackbar__text',
    ACTION: 'mdl-snackbar__action',
    ACTIVE: 'mdl-snackbar--active'
};
/**
   * Display the snackbar.
   *
   * @private
   */
MaterialSnackbar.prototype.displaySnackbar_ = function () {
    this.element_.setAttribute('aria-hidden', 'true');
    if (this.actionHandler_) {
        this.actionElement_.textContent = this.actionText_;
        this.actionElement_.addEventListener('click', this.actionHandler_);
        this.setActionHidden_(false);
    }
    this.textElement_.textContent = this.message_;
    this.element_.classList.add(this.cssClasses_.ACTIVE);
    this.element_.setAttribute('aria-hidden', 'false');
    setTimeout(this.cleanup_.bind(this), this.timeout_);
};
/**
   * Show the snackbar.
   *
   * @param {Object} data The data for the notification.
   * @public
   */
MaterialSnackbar.prototype.showSnackbar = function (data) {
    if (data === undefined) {
        throw new Error('Please provide a data object with at least a message to display.');
    }
    if (data['message'] === undefined) {
        throw new Error('Please provide a message to be displayed.');
    }
    if (data['actionHandler'] && !data['actionText']) {
        throw new Error('Please provide action text with the handler.');
    }
    if (this.active) {
        this.queuedNotifications_.push(data);
    } else {
        this.active = true;
        this.message_ = data['message'];
        if (data['timeout']) {
            this.timeout_ = data['timeout'];
        } else {
            this.timeout_ = 2750;
        }
        if (data['actionHandler']) {
            this.actionHandler_ = data['actionHandler'];
        }
        if (data['actionText']) {
            this.actionText_ = data['actionText'];
        }
        this.displaySnackbar_();
    }
};
MaterialSnackbar.prototype['showSnackbar'] = MaterialSnackbar.prototype.showSnackbar;
/**
   * Check if the queue has items within it.
   * If it does, display the next entry.
   *
   * @private
   */
MaterialSnackbar.prototype.checkQueue_ = function () {
    if (this.queuedNotifications_.length > 0) {
        this.showSnackbar(this.queuedNotifications_.shift());
    }
};
/**
   * Cleanup the snackbar event listeners and accessiblity attributes.
   *
   * @private
   */
MaterialSnackbar.prototype.cleanup_ = function () {
    this.element_.classList.remove(this.cssClasses_.ACTIVE);
    setTimeout(function () {
        this.element_.setAttribute('aria-hidden', 'true');
        this.textElement_.textContent = '';
        if (!Boolean(this.actionElement_.getAttribute('aria-hidden'))) {
            this.setActionHidden_(true);
            this.actionElement_.textContent = '';
            this.actionElement_.removeEventListener('click', this.actionHandler_);
        }
        this.actionHandler_ = undefined;
        this.message_ = undefined;
        this.actionText_ = undefined;
        this.active = false;
        this.checkQueue_();
    }.bind(this), this.Constant_.ANIMATION_LENGTH);
};
/**
   * Set the action handler hidden state.
   *
   * @param {boolean} value
   * @private
   */
MaterialSnackbar.prototype.setActionHidden_ = function (value) {
    if (value) {
        this.actionElement_.setAttribute('aria-hidden', 'true');
    } else {
        this.actionElement_.removeAttribute('aria-hidden');
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialSnackbar,
    classAsString: 'MaterialSnackbar',
    cssClass: 'mdl-js-snackbar',
    widget: true
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Spinner MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @param {HTMLElement} element The element that will be upgraded.
   * @constructor
   */
var MaterialSpinner = function MaterialSpinner(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialSpinner'] = MaterialSpinner;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialSpinner.prototype.Constant_ = { MDL_SPINNER_LAYER_COUNT: 4 };
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialSpinner.prototype.CssClasses_ = {
    MDL_SPINNER_LAYER: 'mdl-spinner__layer',
    MDL_SPINNER_CIRCLE_CLIPPER: 'mdl-spinner__circle-clipper',
    MDL_SPINNER_CIRCLE: 'mdl-spinner__circle',
    MDL_SPINNER_GAP_PATCH: 'mdl-spinner__gap-patch',
    MDL_SPINNER_LEFT: 'mdl-spinner__left',
    MDL_SPINNER_RIGHT: 'mdl-spinner__right'
};
/**
   * Auxiliary method to create a spinner layer.
   *
   * @param {number} index Index of the layer to be created.
   * @public
   */
MaterialSpinner.prototype.createLayer = function (index) {
    var layer = document.createElement('div');
    layer.classList.add(this.CssClasses_.MDL_SPINNER_LAYER);
    layer.classList.add(this.CssClasses_.MDL_SPINNER_LAYER + '-' + index);
    var leftClipper = document.createElement('div');
    leftClipper.classList.add(this.CssClasses_.MDL_SPINNER_CIRCLE_CLIPPER);
    leftClipper.classList.add(this.CssClasses_.MDL_SPINNER_LEFT);
    var gapPatch = document.createElement('div');
    gapPatch.classList.add(this.CssClasses_.MDL_SPINNER_GAP_PATCH);
    var rightClipper = document.createElement('div');
    rightClipper.classList.add(this.CssClasses_.MDL_SPINNER_CIRCLE_CLIPPER);
    rightClipper.classList.add(this.CssClasses_.MDL_SPINNER_RIGHT);
    var circleOwners = [
        leftClipper,
        gapPatch,
        rightClipper
    ];
    for (var i = 0; i < circleOwners.length; i++) {
        var circle = document.createElement('div');
        circle.classList.add(this.CssClasses_.MDL_SPINNER_CIRCLE);
        circleOwners[i].appendChild(circle);
    }
    layer.appendChild(leftClipper);
    layer.appendChild(gapPatch);
    layer.appendChild(rightClipper);
    this.element_.appendChild(layer);
};
MaterialSpinner.prototype['createLayer'] = MaterialSpinner.prototype.createLayer;
/**
   * Stops the spinner animation.
   * Public method for users who need to stop the spinner for any reason.
   *
   * @public
   */
MaterialSpinner.prototype.stop = function () {
    this.element_.classList.remove('is-active');
};
MaterialSpinner.prototype['stop'] = MaterialSpinner.prototype.stop;
/**
   * Starts the spinner animation.
   * Public method for users who need to manually start the spinner for any reason
   * (instead of just adding the 'is-active' class to their markup).
   *
   * @public
   */
MaterialSpinner.prototype.start = function () {
    this.element_.classList.add('is-active');
};
MaterialSpinner.prototype['start'] = MaterialSpinner.prototype.start;
/**
   * Initialize element.
   */
MaterialSpinner.prototype.init = function () {
    if (this.element_) {
        for (var i = 1; i <= this.Constant_.MDL_SPINNER_LAYER_COUNT; i++) {
            this.createLayer(i);
        }
        this.element_.classList.add('is-upgraded');
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialSpinner,
    classAsString: 'MaterialSpinner',
    cssClass: 'mdl-js-spinner',
    widget: true
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Checkbox MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialSwitch = function MaterialSwitch(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialSwitch'] = MaterialSwitch;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialSwitch.prototype.Constant_ = { TINY_TIMEOUT: 0.001 };
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialSwitch.prototype.CssClasses_ = {
    INPUT: 'mdl-switch__input',
    TRACK: 'mdl-switch__track',
    THUMB: 'mdl-switch__thumb',
    FOCUS_HELPER: 'mdl-switch__focus-helper',
    RIPPLE_EFFECT: 'mdl-js-ripple-effect',
    RIPPLE_IGNORE_EVENTS: 'mdl-js-ripple-effect--ignore-events',
    RIPPLE_CONTAINER: 'mdl-switch__ripple-container',
    RIPPLE_CENTER: 'mdl-ripple--center',
    RIPPLE: 'mdl-ripple',
    IS_FOCUSED: 'is-focused',
    IS_DISABLED: 'is-disabled',
    IS_CHECKED: 'is-checked'
};
/**
   * Handle change of state.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialSwitch.prototype.onChange_ = function (event) {
    this.updateClasses_();
};
/**
   * Handle focus of element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialSwitch.prototype.onFocus_ = function (event) {
    this.element_.classList.add(this.CssClasses_.IS_FOCUSED);
};
/**
   * Handle lost focus of element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialSwitch.prototype.onBlur_ = function (event) {
    this.element_.classList.remove(this.CssClasses_.IS_FOCUSED);
};
/**
   * Handle mouseup.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialSwitch.prototype.onMouseUp_ = function (event) {
    this.blur_();
};
/**
   * Handle class updates.
   *
   * @private
   */
MaterialSwitch.prototype.updateClasses_ = function () {
    this.checkDisabled();
    this.checkToggleState();
};
/**
   * Add blur.
   *
   * @private
   */
MaterialSwitch.prototype.blur_ = function () {
    // TODO: figure out why there's a focus event being fired after our blur,
    // so that we can avoid this hack.
    window.setTimeout(function () {
        this.inputElement_.blur();
    }.bind(this), this.Constant_.TINY_TIMEOUT);
};
// Public methods.
/**
   * Check the components disabled state.
   *
   * @public
   */
MaterialSwitch.prototype.checkDisabled = function () {
    if (this.inputElement_.disabled) {
        this.element_.classList.add(this.CssClasses_.IS_DISABLED);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_DISABLED);
    }
};
MaterialSwitch.prototype['checkDisabled'] = MaterialSwitch.prototype.checkDisabled;
/**
   * Check the components toggled state.
   *
   * @public
   */
MaterialSwitch.prototype.checkToggleState = function () {
    if (this.inputElement_.checked) {
        this.element_.classList.add(this.CssClasses_.IS_CHECKED);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_CHECKED);
    }
};
MaterialSwitch.prototype['checkToggleState'] = MaterialSwitch.prototype.checkToggleState;
/**
   * Disable switch.
   *
   * @public
   */
MaterialSwitch.prototype.disable = function () {
    this.inputElement_.disabled = true;
    this.updateClasses_();
};
MaterialSwitch.prototype['disable'] = MaterialSwitch.prototype.disable;
/**
   * Enable switch.
   *
   * @public
   */
MaterialSwitch.prototype.enable = function () {
    this.inputElement_.disabled = false;
    this.updateClasses_();
};
MaterialSwitch.prototype['enable'] = MaterialSwitch.prototype.enable;
/**
   * Activate switch.
   *
   * @public
   */
MaterialSwitch.prototype.on = function () {
    this.inputElement_.checked = true;
    this.updateClasses_();
};
MaterialSwitch.prototype['on'] = MaterialSwitch.prototype.on;
/**
   * Deactivate switch.
   *
   * @public
   */
MaterialSwitch.prototype.off = function () {
    this.inputElement_.checked = false;
    this.updateClasses_();
};
MaterialSwitch.prototype['off'] = MaterialSwitch.prototype.off;
/**
   * Initialize element.
   */
MaterialSwitch.prototype.init = function () {
    if (this.element_) {
        this.inputElement_ = this.element_.querySelector('.' + this.CssClasses_.INPUT);
        var track = document.createElement('div');
        track.classList.add(this.CssClasses_.TRACK);
        var thumb = document.createElement('div');
        thumb.classList.add(this.CssClasses_.THUMB);
        var focusHelper = document.createElement('span');
        focusHelper.classList.add(this.CssClasses_.FOCUS_HELPER);
        thumb.appendChild(focusHelper);
        this.element_.appendChild(track);
        this.element_.appendChild(thumb);
        this.boundMouseUpHandler = this.onMouseUp_.bind(this);
        if (this.element_.classList.contains(this.CssClasses_.RIPPLE_EFFECT)) {
            this.element_.classList.add(this.CssClasses_.RIPPLE_IGNORE_EVENTS);
            this.rippleContainerElement_ = document.createElement('span');
            this.rippleContainerElement_.classList.add(this.CssClasses_.RIPPLE_CONTAINER);
            this.rippleContainerElement_.classList.add(this.CssClasses_.RIPPLE_EFFECT);
            this.rippleContainerElement_.classList.add(this.CssClasses_.RIPPLE_CENTER);
            this.rippleContainerElement_.addEventListener('mouseup', this.boundMouseUpHandler);
            var ripple = document.createElement('span');
            ripple.classList.add(this.CssClasses_.RIPPLE);
            this.rippleContainerElement_.appendChild(ripple);
            this.element_.appendChild(this.rippleContainerElement_);
        }
        this.boundChangeHandler = this.onChange_.bind(this);
        this.boundFocusHandler = this.onFocus_.bind(this);
        this.boundBlurHandler = this.onBlur_.bind(this);
        this.inputElement_.addEventListener('change', this.boundChangeHandler);
        this.inputElement_.addEventListener('focus', this.boundFocusHandler);
        this.inputElement_.addEventListener('blur', this.boundBlurHandler);
        this.element_.addEventListener('mouseup', this.boundMouseUpHandler);
        this.updateClasses_();
        this.element_.classList.add('is-upgraded');
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialSwitch,
    classAsString: 'MaterialSwitch',
    cssClass: 'mdl-js-switch',
    widget: true
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Tabs MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {Element} element The element that will be upgraded.
   */
var MaterialTabs = function MaterialTabs(element) {
    // Stores the HTML element.
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialTabs'] = MaterialTabs;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string}
   * @private
   */
MaterialTabs.prototype.Constant_ = {};
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialTabs.prototype.CssClasses_ = {
    TAB_CLASS: 'mdl-tabs__tab',
    PANEL_CLASS: 'mdl-tabs__panel',
    ACTIVE_CLASS: 'is-active',
    UPGRADED_CLASS: 'is-upgraded',
    MDL_JS_RIPPLE_EFFECT: 'mdl-js-ripple-effect',
    MDL_RIPPLE_CONTAINER: 'mdl-tabs__ripple-container',
    MDL_RIPPLE: 'mdl-ripple',
    MDL_JS_RIPPLE_EFFECT_IGNORE_EVENTS: 'mdl-js-ripple-effect--ignore-events'
};
/**
   * Handle clicks to a tabs component
   *
   * @private
   */
MaterialTabs.prototype.initTabs_ = function () {
    if (this.element_.classList.contains(this.CssClasses_.MDL_JS_RIPPLE_EFFECT)) {
        this.element_.classList.add(this.CssClasses_.MDL_JS_RIPPLE_EFFECT_IGNORE_EVENTS);
    }
    // Select element tabs, document panels
    this.tabs_ = this.element_.querySelectorAll('.' + this.CssClasses_.TAB_CLASS);
    this.panels_ = this.element_.querySelectorAll('.' + this.CssClasses_.PANEL_CLASS);
    // Create new tabs for each tab element
    for (var i = 0; i < this.tabs_.length; i++) {
        new MaterialTab(this.tabs_[i], this);
    }
    this.element_.classList.add(this.CssClasses_.UPGRADED_CLASS);
};
/**
   * Reset tab state, dropping active classes
   *
   * @private
   */
MaterialTabs.prototype.resetTabState_ = function () {
    for (var k = 0; k < this.tabs_.length; k++) {
        this.tabs_[k].classList.remove(this.CssClasses_.ACTIVE_CLASS);
    }
};
/**
   * Reset panel state, droping active classes
   *
   * @private
   */
MaterialTabs.prototype.resetPanelState_ = function () {
    for (var j = 0; j < this.panels_.length; j++) {
        this.panels_[j].classList.remove(this.CssClasses_.ACTIVE_CLASS);
    }
};
/**
   * Initialize element.
   */
MaterialTabs.prototype.init = function () {
    if (this.element_) {
        this.initTabs_();
    }
};
/**
   * Constructor for an individual tab.
   *
   * @constructor
   * @param {Element} tab The HTML element for the tab.
   * @param {MaterialTabs} ctx The MaterialTabs object that owns the tab.
   */
function MaterialTab(tab, ctx) {
    if (tab) {
        if (ctx.element_.classList.contains(ctx.CssClasses_.MDL_JS_RIPPLE_EFFECT)) {
            var rippleContainer = document.createElement('span');
            rippleContainer.classList.add(ctx.CssClasses_.MDL_RIPPLE_CONTAINER);
            rippleContainer.classList.add(ctx.CssClasses_.MDL_JS_RIPPLE_EFFECT);
            var ripple = document.createElement('span');
            ripple.classList.add(ctx.CssClasses_.MDL_RIPPLE);
            rippleContainer.appendChild(ripple);
            tab.appendChild(rippleContainer);
        }
        tab.addEventListener('click', function (e) {
            if (tab.getAttribute('href').charAt(0) === '#') {
                e.preventDefault();
                var href = tab.href.split('#')[1];
                var panel = ctx.element_.querySelector('#' + href);
                ctx.resetTabState_();
                ctx.resetPanelState_();
                tab.classList.add(ctx.CssClasses_.ACTIVE_CLASS);
                panel.classList.add(ctx.CssClasses_.ACTIVE_CLASS);
            }
        });
    }
}
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialTabs,
    classAsString: 'MaterialTabs',
    cssClass: 'mdl-js-tabs'
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Textfield MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialTextfield = function MaterialTextfield(element) {
    this.element_ = element;
    this.maxRows = this.Constant_.NO_MAX_ROWS;
    // Initialize instance.
    this.init();
};
window['MaterialTextfield'] = MaterialTextfield;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialTextfield.prototype.Constant_ = {
    NO_MAX_ROWS: -1,
    MAX_ROWS_ATTRIBUTE: 'maxrows'
};
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialTextfield.prototype.CssClasses_ = {
    LABEL: 'mdl-textfield__label',
    INPUT: 'mdl-textfield__input',
    IS_DIRTY: 'is-dirty',
    IS_FOCUSED: 'is-focused',
    IS_DISABLED: 'is-disabled',
    IS_INVALID: 'is-invalid',
    IS_UPGRADED: 'is-upgraded',
    HAS_PLACEHOLDER: 'has-placeholder'
};
/**
   * Handle input being entered.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialTextfield.prototype.onKeyDown_ = function (event) {
    var currentRowCount = event.target.value.split('\n').length;
    if (event.keyCode === 13) {
        if (currentRowCount >= this.maxRows) {
            event.preventDefault();
        }
    }
};
/**
   * Handle focus.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialTextfield.prototype.onFocus_ = function (event) {
    this.element_.classList.add(this.CssClasses_.IS_FOCUSED);
};
/**
   * Handle lost focus.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialTextfield.prototype.onBlur_ = function (event) {
    this.element_.classList.remove(this.CssClasses_.IS_FOCUSED);
};
/**
   * Handle reset event from out side.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialTextfield.prototype.onReset_ = function (event) {
    this.updateClasses_();
};
/**
   * Handle class updates.
   *
   * @private
   */
MaterialTextfield.prototype.updateClasses_ = function () {
    this.checkDisabled();
    this.checkValidity();
    this.checkDirty();
    this.checkFocus();
};
// Public methods.
/**
   * Check the disabled state and update field accordingly.
   *
   * @public
   */
MaterialTextfield.prototype.checkDisabled = function () {
    if (this.input_.disabled) {
        this.element_.classList.add(this.CssClasses_.IS_DISABLED);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_DISABLED);
    }
};
MaterialTextfield.prototype['checkDisabled'] = MaterialTextfield.prototype.checkDisabled;
/**
  * Check the focus state and update field accordingly.
  *
  * @public
  */
MaterialTextfield.prototype.checkFocus = function () {
    if (Boolean(this.element_.querySelector(':focus'))) {
        this.element_.classList.add(this.CssClasses_.IS_FOCUSED);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_FOCUSED);
    }
};
MaterialTextfield.prototype['checkFocus'] = MaterialTextfield.prototype.checkFocus;
/**
   * Check the validity state and update field accordingly.
   *
   * @public
   */
MaterialTextfield.prototype.checkValidity = function () {
    if (this.input_.validity) {
        if (this.input_.validity.valid) {
            this.element_.classList.remove(this.CssClasses_.IS_INVALID);
        } else {
            this.element_.classList.add(this.CssClasses_.IS_INVALID);
        }
    }
};
MaterialTextfield.prototype['checkValidity'] = MaterialTextfield.prototype.checkValidity;
/**
   * Check the dirty state and update field accordingly.
   *
   * @public
   */
MaterialTextfield.prototype.checkDirty = function () {
    if (this.input_.value && this.input_.value.length > 0) {
        this.element_.classList.add(this.CssClasses_.IS_DIRTY);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_DIRTY);
    }
};
MaterialTextfield.prototype['checkDirty'] = MaterialTextfield.prototype.checkDirty;
/**
   * Disable text field.
   *
   * @public
   */
MaterialTextfield.prototype.disable = function () {
    this.input_.disabled = true;
    this.updateClasses_();
};
MaterialTextfield.prototype['disable'] = MaterialTextfield.prototype.disable;
/**
   * Enable text field.
   *
   * @public
   */
MaterialTextfield.prototype.enable = function () {
    this.input_.disabled = false;
    this.updateClasses_();
};
MaterialTextfield.prototype['enable'] = MaterialTextfield.prototype.enable;
/**
   * Update text field value.
   *
   * @param {string} value The value to which to set the control (optional).
   * @public
   */
MaterialTextfield.prototype.change = function (value) {
    this.input_.value = value || '';
    this.updateClasses_();
};
MaterialTextfield.prototype['change'] = MaterialTextfield.prototype.change;
/**
   * Initialize element.
   */
MaterialTextfield.prototype.init = function () {
    if (this.element_) {
        this.label_ = this.element_.querySelector('.' + this.CssClasses_.LABEL);
        this.input_ = this.element_.querySelector('.' + this.CssClasses_.INPUT);
        if (this.input_) {
            if (this.input_.hasAttribute(this.Constant_.MAX_ROWS_ATTRIBUTE)) {
                this.maxRows = parseInt(this.input_.getAttribute(this.Constant_.MAX_ROWS_ATTRIBUTE), 10);
                if (isNaN(this.maxRows)) {
                    this.maxRows = this.Constant_.NO_MAX_ROWS;
                }
            }
            if (this.input_.hasAttribute('placeholder')) {
                this.element_.classList.add(this.CssClasses_.HAS_PLACEHOLDER);
            }
            this.boundUpdateClassesHandler = this.updateClasses_.bind(this);
            this.boundFocusHandler = this.onFocus_.bind(this);
            this.boundBlurHandler = this.onBlur_.bind(this);
            this.boundResetHandler = this.onReset_.bind(this);
            this.input_.addEventListener('input', this.boundUpdateClassesHandler);
            this.input_.addEventListener('focus', this.boundFocusHandler);
            this.input_.addEventListener('blur', this.boundBlurHandler);
            this.input_.addEventListener('reset', this.boundResetHandler);
            if (this.maxRows !== this.Constant_.NO_MAX_ROWS) {
                // TODO: This should handle pasting multi line text.
                // Currently doesn't.
                this.boundKeyDownHandler = this.onKeyDown_.bind(this);
                this.input_.addEventListener('keydown', this.boundKeyDownHandler);
            }
            var invalid = this.element_.classList.contains(this.CssClasses_.IS_INVALID);
            this.updateClasses_();
            this.element_.classList.add(this.CssClasses_.IS_UPGRADED);
            if (invalid) {
                this.element_.classList.add(this.CssClasses_.IS_INVALID);
            }
            if (this.input_.hasAttribute('autofocus')) {
                this.element_.focus();
                this.checkFocus();
            }
        }
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialTextfield,
    classAsString: 'MaterialTextfield',
    cssClass: 'mdl-js-textfield',
    widget: true
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Tooltip MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialTooltip = function MaterialTooltip(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialTooltip'] = MaterialTooltip;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialTooltip.prototype.Constant_ = {};
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialTooltip.prototype.CssClasses_ = {
    IS_ACTIVE: 'is-active',
    BOTTOM: 'mdl-tooltip--bottom',
    LEFT: 'mdl-tooltip--left',
    RIGHT: 'mdl-tooltip--right',
    TOP: 'mdl-tooltip--top'
};
/**
   * Handle mouseenter for tooltip.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialTooltip.prototype.handleMouseEnter_ = function (event) {
    var props = event.target.getBoundingClientRect();
    var left = props.left + props.width / 2;
    var top = props.top + props.height / 2;
    var marginLeft = -1 * (this.element_.offsetWidth / 2);
    var marginTop = -1 * (this.element_.offsetHeight / 2);
    if (this.element_.classList.contains(this.CssClasses_.LEFT) || this.element_.classList.contains(this.CssClasses_.RIGHT)) {
        left = props.width / 2;
        if (top + marginTop < 0) {
            this.element_.style.top = '0';
            this.element_.style.marginTop = '0';
        } else {
            this.element_.style.top = top + 'px';
            this.element_.style.marginTop = marginTop + 'px';
        }
    } else {
        if (left + marginLeft < 0) {
            this.element_.style.left = '0';
            this.element_.style.marginLeft = '0';
        } else {
            this.element_.style.left = left + 'px';
            this.element_.style.marginLeft = marginLeft + 'px';
        }
    }
    if (this.element_.classList.contains(this.CssClasses_.TOP)) {
        this.element_.style.top = props.top - this.element_.offsetHeight - 10 + 'px';
    } else if (this.element_.classList.contains(this.CssClasses_.RIGHT)) {
        this.element_.style.left = props.left + props.width + 10 + 'px';
    } else if (this.element_.classList.contains(this.CssClasses_.LEFT)) {
        this.element_.style.left = props.left - this.element_.offsetWidth - 10 + 'px';
    } else {
        this.element_.style.top = props.top + props.height + 10 + 'px';
    }
    this.element_.classList.add(this.CssClasses_.IS_ACTIVE);
};
/**
   * Hide tooltip on mouseleave or scroll
   *
   * @private
   */
MaterialTooltip.prototype.hideTooltip_ = function () {
    this.element_.classList.remove(this.CssClasses_.IS_ACTIVE);
};
/**
   * Initialize element.
   */
MaterialTooltip.prototype.init = function () {
    if (this.element_) {
        var forElId = this.element_.getAttribute('for') || this.element_.getAttribute('data-mdl-for');
        if (forElId) {
            this.forElement_ = document.getElementById(forElId);
        }
        if (this.forElement_) {
            // It's left here because it prevents accidental text selection on Android
            if (!this.forElement_.hasAttribute('tabindex')) {
                this.forElement_.setAttribute('tabindex', '0');
            }
            this.boundMouseEnterHandler = this.handleMouseEnter_.bind(this);
            this.boundMouseLeaveAndScrollHandler = this.hideTooltip_.bind(this);
            this.forElement_.addEventListener('mouseenter', this.boundMouseEnterHandler, false);
            this.forElement_.addEventListener('touchend', this.boundMouseEnterHandler, false);
            this.forElement_.addEventListener('mouseleave', this.boundMouseLeaveAndScrollHandler, false);
            window.addEventListener('scroll', this.boundMouseLeaveAndScrollHandler, true);
            window.addEventListener('touchstart', this.boundMouseLeaveAndScrollHandler);
        }
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialTooltip,
    classAsString: 'MaterialTooltip',
    cssClass: 'mdl-tooltip'
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Layout MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialLayout = function MaterialLayout(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialLayout'] = MaterialLayout;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialLayout.prototype.Constant_ = {
    MAX_WIDTH: '(max-width: 1024px)',
    TAB_SCROLL_PIXELS: 100,
    RESIZE_TIMEOUT: 100,
    MENU_ICON: '&#xE5D2;',
    CHEVRON_LEFT: 'chevron_left',
    CHEVRON_RIGHT: 'chevron_right'
};
/**
   * Keycodes, for code readability.
   *
   * @enum {number}
   * @private
   */
MaterialLayout.prototype.Keycodes_ = {
    ENTER: 13,
    ESCAPE: 27,
    SPACE: 32
};
/**
   * Modes.
   *
   * @enum {number}
   * @private
   */
MaterialLayout.prototype.Mode_ = {
    STANDARD: 0,
    SEAMED: 1,
    WATERFALL: 2,
    SCROLL: 3
};
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialLayout.prototype.CssClasses_ = {
    CONTAINER: 'mdl-layout__container',
    HEADER: 'mdl-layout__header',
    DRAWER: 'mdl-layout__drawer',
    CONTENT: 'mdl-layout__content',
    DRAWER_BTN: 'mdl-layout__drawer-button',
    ICON: 'material-icons',
    JS_RIPPLE_EFFECT: 'mdl-js-ripple-effect',
    RIPPLE_CONTAINER: 'mdl-layout__tab-ripple-container',
    RIPPLE: 'mdl-ripple',
    RIPPLE_IGNORE_EVENTS: 'mdl-js-ripple-effect--ignore-events',
    HEADER_SEAMED: 'mdl-layout__header--seamed',
    HEADER_WATERFALL: 'mdl-layout__header--waterfall',
    HEADER_SCROLL: 'mdl-layout__header--scroll',
    FIXED_HEADER: 'mdl-layout--fixed-header',
    OBFUSCATOR: 'mdl-layout__obfuscator',
    TAB_BAR: 'mdl-layout__tab-bar',
    TAB_CONTAINER: 'mdl-layout__tab-bar-container',
    TAB: 'mdl-layout__tab',
    TAB_BAR_BUTTON: 'mdl-layout__tab-bar-button',
    TAB_BAR_LEFT_BUTTON: 'mdl-layout__tab-bar-left-button',
    TAB_BAR_RIGHT_BUTTON: 'mdl-layout__tab-bar-right-button',
    TAB_MANUAL_SWITCH: 'mdl-layout__tab-manual-switch',
    PANEL: 'mdl-layout__tab-panel',
    HAS_DRAWER: 'has-drawer',
    HAS_TABS: 'has-tabs',
    HAS_SCROLLING_HEADER: 'has-scrolling-header',
    CASTING_SHADOW: 'is-casting-shadow',
    IS_COMPACT: 'is-compact',
    IS_SMALL_SCREEN: 'is-small-screen',
    IS_DRAWER_OPEN: 'is-visible',
    IS_ACTIVE: 'is-active',
    IS_UPGRADED: 'is-upgraded',
    IS_ANIMATING: 'is-animating',
    ON_LARGE_SCREEN: 'mdl-layout--large-screen-only',
    ON_SMALL_SCREEN: 'mdl-layout--small-screen-only'
};
/**
   * Handles scrolling on the content.
   *
   * @private
   */
MaterialLayout.prototype.contentScrollHandler_ = function () {
    if (this.header_.classList.contains(this.CssClasses_.IS_ANIMATING)) {
        return;
    }
    var headerVisible = !this.element_.classList.contains(this.CssClasses_.IS_SMALL_SCREEN) || this.element_.classList.contains(this.CssClasses_.FIXED_HEADER);
    if (this.content_.scrollTop > 0 && !this.header_.classList.contains(this.CssClasses_.IS_COMPACT)) {
        this.header_.classList.add(this.CssClasses_.CASTING_SHADOW);
        this.header_.classList.add(this.CssClasses_.IS_COMPACT);
        if (headerVisible) {
            this.header_.classList.add(this.CssClasses_.IS_ANIMATING);
        }
    } else if (this.content_.scrollTop <= 0 && this.header_.classList.contains(this.CssClasses_.IS_COMPACT)) {
        this.header_.classList.remove(this.CssClasses_.CASTING_SHADOW);
        this.header_.classList.remove(this.CssClasses_.IS_COMPACT);
        if (headerVisible) {
            this.header_.classList.add(this.CssClasses_.IS_ANIMATING);
        }
    }
};
/**
   * Handles a keyboard event on the drawer.
   *
   * @param {Event} evt The event that fired.
   * @private
   */
MaterialLayout.prototype.keyboardEventHandler_ = function (evt) {
    // Only react when the drawer is open.
    if (evt.keyCode === this.Keycodes_.ESCAPE && this.drawer_.classList.contains(this.CssClasses_.IS_DRAWER_OPEN)) {
        this.toggleDrawer();
    }
};
/**
   * Handles changes in screen size.
   *
   * @private
   */
MaterialLayout.prototype.screenSizeHandler_ = function () {
    if (this.screenSizeMediaQuery_.matches) {
        this.element_.classList.add(this.CssClasses_.IS_SMALL_SCREEN);
    } else {
        this.element_.classList.remove(this.CssClasses_.IS_SMALL_SCREEN);
        // Collapse drawer (if any) when moving to a large screen size.
        if (this.drawer_) {
            this.drawer_.classList.remove(this.CssClasses_.IS_DRAWER_OPEN);
            this.obfuscator_.classList.remove(this.CssClasses_.IS_DRAWER_OPEN);
        }
    }
};
/**
   * Handles events of drawer button.
   *
   * @param {Event} evt The event that fired.
   * @private
   */
MaterialLayout.prototype.drawerToggleHandler_ = function (evt) {
    if (evt && evt.type === 'keydown') {
        if (evt.keyCode === this.Keycodes_.SPACE || evt.keyCode === this.Keycodes_.ENTER) {
            // prevent scrolling in drawer nav
            evt.preventDefault();
        } else {
            // prevent other keys
            return;
        }
    }
    this.toggleDrawer();
};
/**
   * Handles (un)setting the `is-animating` class
   *
   * @private
   */
MaterialLayout.prototype.headerTransitionEndHandler_ = function () {
    this.header_.classList.remove(this.CssClasses_.IS_ANIMATING);
};
/**
   * Handles expanding the header on click
   *
   * @private
   */
MaterialLayout.prototype.headerClickHandler_ = function () {
    if (this.header_.classList.contains(this.CssClasses_.IS_COMPACT)) {
        this.header_.classList.remove(this.CssClasses_.IS_COMPACT);
        this.header_.classList.add(this.CssClasses_.IS_ANIMATING);
    }
};
/**
   * Reset tab state, dropping active classes
   *
   * @private
   */
MaterialLayout.prototype.resetTabState_ = function (tabBar) {
    for (var k = 0; k < tabBar.length; k++) {
        tabBar[k].classList.remove(this.CssClasses_.IS_ACTIVE);
    }
};
/**
   * Reset panel state, droping active classes
   *
   * @private
   */
MaterialLayout.prototype.resetPanelState_ = function (panels) {
    for (var j = 0; j < panels.length; j++) {
        panels[j].classList.remove(this.CssClasses_.IS_ACTIVE);
    }
};
/**
  * Toggle drawer state
  *
  * @public
  */
MaterialLayout.prototype.toggleDrawer = function () {
    var drawerButton = this.element_.querySelector('.' + this.CssClasses_.DRAWER_BTN);
    this.drawer_.classList.toggle(this.CssClasses_.IS_DRAWER_OPEN);
    this.obfuscator_.classList.toggle(this.CssClasses_.IS_DRAWER_OPEN);
    // Set accessibility properties.
    if (this.drawer_.classList.contains(this.CssClasses_.IS_DRAWER_OPEN)) {
        this.drawer_.setAttribute('aria-hidden', 'false');
        drawerButton.setAttribute('aria-expanded', 'true');
    } else {
        this.drawer_.setAttribute('aria-hidden', 'true');
        drawerButton.setAttribute('aria-expanded', 'false');
    }
};
MaterialLayout.prototype['toggleDrawer'] = MaterialLayout.prototype.toggleDrawer;
/**
   * Initialize element.
   */
MaterialLayout.prototype.init = function () {
    if (this.element_) {
        var container = document.createElement('div');
        container.classList.add(this.CssClasses_.CONTAINER);
        var focusedElement = this.element_.querySelector(':focus');
        this.element_.parentElement.insertBefore(container, this.element_);
        this.element_.parentElement.removeChild(this.element_);
        container.appendChild(this.element_);
        if (focusedElement) {
            focusedElement.focus();
        }
        var directChildren = this.element_.childNodes;
        var numChildren = directChildren.length;
        for (var c = 0; c < numChildren; c++) {
            var child = directChildren[c];
            if (child.classList && child.classList.contains(this.CssClasses_.HEADER)) {
                this.header_ = child;
            }
            if (child.classList && child.classList.contains(this.CssClasses_.DRAWER)) {
                this.drawer_ = child;
            }
            if (child.classList && child.classList.contains(this.CssClasses_.CONTENT)) {
                this.content_ = child;
            }
        }
        window.addEventListener('pageshow', function (e) {
            if (e.persisted) {
                // when page is loaded from back/forward cache
                // trigger repaint to let layout scroll in safari
                this.element_.style.overflowY = 'hidden';
                requestAnimationFrame(function () {
                    this.element_.style.overflowY = '';
                }.bind(this));
            }
        }.bind(this), false);
        if (this.header_) {
            this.tabBar_ = this.header_.querySelector('.' + this.CssClasses_.TAB_BAR);
        }
        var mode = this.Mode_.STANDARD;
        if (this.header_) {
            if (this.header_.classList.contains(this.CssClasses_.HEADER_SEAMED)) {
                mode = this.Mode_.SEAMED;
            } else if (this.header_.classList.contains(this.CssClasses_.HEADER_WATERFALL)) {
                mode = this.Mode_.WATERFALL;
                this.header_.addEventListener('transitionend', this.headerTransitionEndHandler_.bind(this));
                this.header_.addEventListener('click', this.headerClickHandler_.bind(this));
            } else if (this.header_.classList.contains(this.CssClasses_.HEADER_SCROLL)) {
                mode = this.Mode_.SCROLL;
                container.classList.add(this.CssClasses_.HAS_SCROLLING_HEADER);
            }
            if (mode === this.Mode_.STANDARD) {
                this.header_.classList.add(this.CssClasses_.CASTING_SHADOW);
                if (this.tabBar_) {
                    this.tabBar_.classList.add(this.CssClasses_.CASTING_SHADOW);
                }
            } else if (mode === this.Mode_.SEAMED || mode === this.Mode_.SCROLL) {
                this.header_.classList.remove(this.CssClasses_.CASTING_SHADOW);
                if (this.tabBar_) {
                    this.tabBar_.classList.remove(this.CssClasses_.CASTING_SHADOW);
                }
            } else if (mode === this.Mode_.WATERFALL) {
                // Add and remove shadows depending on scroll position.
                // Also add/remove auxiliary class for styling of the compact version of
                // the header.
                this.content_.addEventListener('scroll', this.contentScrollHandler_.bind(this));
                this.contentScrollHandler_();
            }
        }
        // Add drawer toggling button to our layout, if we have an openable drawer.
        if (this.drawer_) {
            var drawerButton = this.element_.querySelector('.' + this.CssClasses_.DRAWER_BTN);
            if (!drawerButton) {
                drawerButton = document.createElement('div');
                drawerButton.setAttribute('aria-expanded', 'false');
                drawerButton.setAttribute('role', 'button');
                drawerButton.setAttribute('tabindex', '0');
                drawerButton.classList.add(this.CssClasses_.DRAWER_BTN);
                var drawerButtonIcon = document.createElement('i');
                drawerButtonIcon.classList.add(this.CssClasses_.ICON);
                drawerButtonIcon.innerHTML = this.Constant_.MENU_ICON;
                drawerButton.appendChild(drawerButtonIcon);
            }
            if (this.drawer_.classList.contains(this.CssClasses_.ON_LARGE_SCREEN)) {
                //If drawer has ON_LARGE_SCREEN class then add it to the drawer toggle button as well.
                drawerButton.classList.add(this.CssClasses_.ON_LARGE_SCREEN);
            } else if (this.drawer_.classList.contains(this.CssClasses_.ON_SMALL_SCREEN)) {
                //If drawer has ON_SMALL_SCREEN class then add it to the drawer toggle button as well.
                drawerButton.classList.add(this.CssClasses_.ON_SMALL_SCREEN);
            }
            drawerButton.addEventListener('click', this.drawerToggleHandler_.bind(this));
            drawerButton.addEventListener('keydown', this.drawerToggleHandler_.bind(this));
            // Add a class if the layout has a drawer, for altering the left padding.
            // Adds the HAS_DRAWER to the elements since this.header_ may or may
            // not be present.
            this.element_.classList.add(this.CssClasses_.HAS_DRAWER);
            // If we have a fixed header, add the button to the header rather than
            // the layout.
            if (this.element_.classList.contains(this.CssClasses_.FIXED_HEADER)) {
                this.header_.insertBefore(drawerButton, this.header_.firstChild);
            } else {
                this.element_.insertBefore(drawerButton, this.content_);
            }
            var obfuscator = document.createElement('div');
            obfuscator.classList.add(this.CssClasses_.OBFUSCATOR);
            this.element_.appendChild(obfuscator);
            obfuscator.addEventListener('click', this.drawerToggleHandler_.bind(this));
            this.obfuscator_ = obfuscator;
            this.drawer_.addEventListener('keydown', this.keyboardEventHandler_.bind(this));
            this.drawer_.setAttribute('aria-hidden', 'true');
        }
        // Keep an eye on screen size, and add/remove auxiliary class for styling
        // of small screens.
        this.screenSizeMediaQuery_ = window.matchMedia(this.Constant_.MAX_WIDTH);
        this.screenSizeMediaQuery_.addListener(this.screenSizeHandler_.bind(this));
        this.screenSizeHandler_();
        // Initialize tabs, if any.
        if (this.header_ && this.tabBar_) {
            this.element_.classList.add(this.CssClasses_.HAS_TABS);
            var tabContainer = document.createElement('div');
            tabContainer.classList.add(this.CssClasses_.TAB_CONTAINER);
            this.header_.insertBefore(tabContainer, this.tabBar_);
            this.header_.removeChild(this.tabBar_);
            var leftButton = document.createElement('div');
            leftButton.classList.add(this.CssClasses_.TAB_BAR_BUTTON);
            leftButton.classList.add(this.CssClasses_.TAB_BAR_LEFT_BUTTON);
            var leftButtonIcon = document.createElement('i');
            leftButtonIcon.classList.add(this.CssClasses_.ICON);
            leftButtonIcon.textContent = this.Constant_.CHEVRON_LEFT;
            leftButton.appendChild(leftButtonIcon);
            leftButton.addEventListener('click', function () {
                this.tabBar_.scrollLeft -= this.Constant_.TAB_SCROLL_PIXELS;
            }.bind(this));
            var rightButton = document.createElement('div');
            rightButton.classList.add(this.CssClasses_.TAB_BAR_BUTTON);
            rightButton.classList.add(this.CssClasses_.TAB_BAR_RIGHT_BUTTON);
            var rightButtonIcon = document.createElement('i');
            rightButtonIcon.classList.add(this.CssClasses_.ICON);
            rightButtonIcon.textContent = this.Constant_.CHEVRON_RIGHT;
            rightButton.appendChild(rightButtonIcon);
            rightButton.addEventListener('click', function () {
                this.tabBar_.scrollLeft += this.Constant_.TAB_SCROLL_PIXELS;
            }.bind(this));
            tabContainer.appendChild(leftButton);
            tabContainer.appendChild(this.tabBar_);
            tabContainer.appendChild(rightButton);
            // Add and remove tab buttons depending on scroll position and total
            // window size.
            var tabUpdateHandler = function () {
                if (this.tabBar_.scrollLeft > 0) {
                    leftButton.classList.add(this.CssClasses_.IS_ACTIVE);
                } else {
                    leftButton.classList.remove(this.CssClasses_.IS_ACTIVE);
                }
                if (this.tabBar_.scrollLeft < this.tabBar_.scrollWidth - this.tabBar_.offsetWidth) {
                    rightButton.classList.add(this.CssClasses_.IS_ACTIVE);
                } else {
                    rightButton.classList.remove(this.CssClasses_.IS_ACTIVE);
                }
            }.bind(this);
            this.tabBar_.addEventListener('scroll', tabUpdateHandler);
            tabUpdateHandler();
            // Update tabs when the window resizes.
            var windowResizeHandler = function () {
                // Use timeouts to make sure it doesn't happen too often.
                if (this.resizeTimeoutId_) {
                    clearTimeout(this.resizeTimeoutId_);
                }
                this.resizeTimeoutId_ = setTimeout(function () {
                    tabUpdateHandler();
                    this.resizeTimeoutId_ = null;
                }.bind(this), this.Constant_.RESIZE_TIMEOUT);
            }.bind(this);
            window.addEventListener('resize', windowResizeHandler);
            if (this.tabBar_.classList.contains(this.CssClasses_.JS_RIPPLE_EFFECT)) {
                this.tabBar_.classList.add(this.CssClasses_.RIPPLE_IGNORE_EVENTS);
            }
            // Select element tabs, document panels
            var tabs = this.tabBar_.querySelectorAll('.' + this.CssClasses_.TAB);
            var panels = this.content_.querySelectorAll('.' + this.CssClasses_.PANEL);
            // Create new tabs for each tab element
            for (var i = 0; i < tabs.length; i++) {
                new MaterialLayoutTab(tabs[i], tabs, panels, this);
            }
        }
        this.element_.classList.add(this.CssClasses_.IS_UPGRADED);
    }
};
/**
   * Constructor for an individual tab.
   *
   * @constructor
   * @param {HTMLElement} tab The HTML element for the tab.
   * @param {!Array<HTMLElement>} tabs Array with HTML elements for all tabs.
   * @param {!Array<HTMLElement>} panels Array with HTML elements for all panels.
   * @param {MaterialLayout} layout The MaterialLayout object that owns the tab.
   */
function MaterialLayoutTab(tab, tabs, panels, layout) {
    /**
     * Auxiliary method to programmatically select a tab in the UI.
     */
    function selectTab() {
        var href = tab.href.split('#')[1];
        var panel = layout.content_.querySelector('#' + href);
        layout.resetTabState_(tabs);
        layout.resetPanelState_(panels);
        tab.classList.add(layout.CssClasses_.IS_ACTIVE);
        panel.classList.add(layout.CssClasses_.IS_ACTIVE);
    }
    if (layout.tabBar_.classList.contains(layout.CssClasses_.JS_RIPPLE_EFFECT)) {
        var rippleContainer = document.createElement('span');
        rippleContainer.classList.add(layout.CssClasses_.RIPPLE_CONTAINER);
        rippleContainer.classList.add(layout.CssClasses_.JS_RIPPLE_EFFECT);
        var ripple = document.createElement('span');
        ripple.classList.add(layout.CssClasses_.RIPPLE);
        rippleContainer.appendChild(ripple);
        tab.appendChild(rippleContainer);
    }
    if (!layout.tabBar_.classList.contains(layout.CssClasses_.TAB_MANUAL_SWITCH)) {
        tab.addEventListener('click', function (e) {
            if (tab.getAttribute('href').charAt(0) === '#') {
                e.preventDefault();
                selectTab();
            }
        });
    }
    tab.show = selectTab;
}
window['MaterialLayoutTab'] = MaterialLayoutTab;
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialLayout,
    classAsString: 'MaterialLayout',
    cssClass: 'mdl-js-layout'
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Data Table Card MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {Element} element The element that will be upgraded.
   */
var MaterialDataTable = function MaterialDataTable(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialDataTable'] = MaterialDataTable;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialDataTable.prototype.Constant_ = {};
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialDataTable.prototype.CssClasses_ = {
    DATA_TABLE: 'mdl-data-table',
    SELECTABLE: 'mdl-data-table--selectable',
    SELECT_ELEMENT: 'mdl-data-table__select',
    IS_SELECTED: 'is-selected',
    IS_UPGRADED: 'is-upgraded'
};
/**
   * Generates and returns a function that toggles the selection state of a
   * single row (or multiple rows).
   *
   * @param {Element} checkbox Checkbox that toggles the selection state.
   * @param {Element} row Row to toggle when checkbox changes.
   * @param {(Array<Object>|NodeList)=} opt_rows Rows to toggle when checkbox changes.
   * @private
   */
MaterialDataTable.prototype.selectRow_ = function (checkbox, row, opt_rows) {
    if (row) {
        return function () {
            if (checkbox.checked) {
                row.classList.add(this.CssClasses_.IS_SELECTED);
            } else {
                row.classList.remove(this.CssClasses_.IS_SELECTED);
            }
        }.bind(this);
    }
    if (opt_rows) {
        return function () {
            var i;
            var el;
            if (checkbox.checked) {
                for (i = 0; i < opt_rows.length; i++) {
                    el = opt_rows[i].querySelector('td').querySelector('.mdl-checkbox');
                    el['MaterialCheckbox'].check();
                    opt_rows[i].classList.add(this.CssClasses_.IS_SELECTED);
                }
            } else {
                for (i = 0; i < opt_rows.length; i++) {
                    el = opt_rows[i].querySelector('td').querySelector('.mdl-checkbox');
                    el['MaterialCheckbox'].uncheck();
                    opt_rows[i].classList.remove(this.CssClasses_.IS_SELECTED);
                }
            }
        }.bind(this);
    }
};
/**
   * Creates a checkbox for a single or or multiple rows and hooks up the
   * event handling.
   *
   * @param {Element} row Row to toggle when checkbox changes.
   * @param {(Array<Object>|NodeList)=} opt_rows Rows to toggle when checkbox changes.
   * @private
   */
MaterialDataTable.prototype.createCheckbox_ = function (row, opt_rows) {
    var label = document.createElement('label');
    var labelClasses = [
        'mdl-checkbox',
        'mdl-js-checkbox',
        'mdl-js-ripple-effect',
        this.CssClasses_.SELECT_ELEMENT
    ];
    label.className = labelClasses.join(' ');
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.classList.add('mdl-checkbox__input');
    if (row) {
        checkbox.checked = row.classList.contains(this.CssClasses_.IS_SELECTED);
        checkbox.addEventListener('change', this.selectRow_(checkbox, row));
    } else if (opt_rows) {
        checkbox.addEventListener('change', this.selectRow_(checkbox, null, opt_rows));
    }
    label.appendChild(checkbox);
    componentHandler.upgradeElement(label, 'MaterialCheckbox');
    return label;
};
/**
   * Initialize element.
   */
MaterialDataTable.prototype.init = function () {
    if (this.element_) {
        var firstHeader = this.element_.querySelector('th');
        var bodyRows = Array.prototype.slice.call(this.element_.querySelectorAll('tbody tr'));
        var footRows = Array.prototype.slice.call(this.element_.querySelectorAll('tfoot tr'));
        var rows = bodyRows.concat(footRows);
        if (this.element_.classList.contains(this.CssClasses_.SELECTABLE)) {
            var th = document.createElement('th');
            var headerCheckbox = this.createCheckbox_(null, rows);
            th.appendChild(headerCheckbox);
            firstHeader.parentElement.insertBefore(th, firstHeader);
            for (var i = 0; i < rows.length; i++) {
                var firstCell = rows[i].querySelector('td');
                if (firstCell) {
                    var td = document.createElement('td');
                    if (rows[i].parentNode.nodeName.toUpperCase() === 'TBODY') {
                        var rowCheckbox = this.createCheckbox_(rows[i]);
                        td.appendChild(rowCheckbox);
                    }
                    rows[i].insertBefore(td, firstCell);
                }
            }
            this.element_.classList.add(this.CssClasses_.IS_UPGRADED);
        }
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialDataTable,
    classAsString: 'MaterialDataTable',
    cssClass: 'mdl-js-data-table'
});
/**
 * @license
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
   * Class constructor for Ripple MDL component.
   * Implements MDL component design pattern defined at:
   * https://github.com/jasonmayes/mdl-component-design-pattern
   *
   * @constructor
   * @param {HTMLElement} element The element that will be upgraded.
   */
var MaterialRipple = function MaterialRipple(element) {
    this.element_ = element;
    // Initialize instance.
    this.init();
};
window['MaterialRipple'] = MaterialRipple;
/**
   * Store constants in one place so they can be updated easily.
   *
   * @enum {string | number}
   * @private
   */
MaterialRipple.prototype.Constant_ = {
    INITIAL_SCALE: 'scale(0.0001, 0.0001)',
    INITIAL_SIZE: '1px',
    INITIAL_OPACITY: '0.4',
    FINAL_OPACITY: '0',
    FINAL_SCALE: ''
};
/**
   * Store strings for class names defined by this component that are used in
   * JavaScript. This allows us to simply change it in one place should we
   * decide to modify at a later date.
   *
   * @enum {string}
   * @private
   */
MaterialRipple.prototype.CssClasses_ = {
    RIPPLE_CENTER: 'mdl-ripple--center',
    RIPPLE_EFFECT_IGNORE_EVENTS: 'mdl-js-ripple-effect--ignore-events',
    RIPPLE: 'mdl-ripple',
    IS_ANIMATING: 'is-animating',
    IS_VISIBLE: 'is-visible'
};
/**
   * Handle mouse / finger down on element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialRipple.prototype.downHandler_ = function (event) {
    if (!this.rippleElement_.style.width && !this.rippleElement_.style.height) {
        var rect = this.element_.getBoundingClientRect();
        this.boundHeight = rect.height;
        this.boundWidth = rect.width;
        this.rippleSize_ = Math.sqrt(rect.width * rect.width + rect.height * rect.height) * 2 + 2;
        this.rippleElement_.style.width = this.rippleSize_ + 'px';
        this.rippleElement_.style.height = this.rippleSize_ + 'px';
    }
    this.rippleElement_.classList.add(this.CssClasses_.IS_VISIBLE);
    if (event.type === 'mousedown' && this.ignoringMouseDown_) {
        this.ignoringMouseDown_ = false;
    } else {
        if (event.type === 'touchstart') {
            this.ignoringMouseDown_ = true;
        }
        var frameCount = this.getFrameCount();
        if (frameCount > 0) {
            return;
        }
        this.setFrameCount(1);
        var bound = event.currentTarget.getBoundingClientRect();
        var x;
        var y;
        // Check if we are handling a keyboard click.
        if (event.clientX === 0 && event.clientY === 0) {
            x = Math.round(bound.width / 2);
            y = Math.round(bound.height / 2);
        } else {
            var clientX = event.clientX !== undefined ? event.clientX : event.touches[0].clientX;
            var clientY = event.clientY !== undefined ? event.clientY : event.touches[0].clientY;
            x = Math.round(clientX - bound.left);
            y = Math.round(clientY - bound.top);
        }
        this.setRippleXY(x, y);
        this.setRippleStyles(true);
        window.requestAnimationFrame(this.animFrameHandler.bind(this));
    }
};
/**
   * Handle mouse / finger up on element.
   *
   * @param {Event} event The event that fired.
   * @private
   */
MaterialRipple.prototype.upHandler_ = function (event) {
    // Don't fire for the artificial "mouseup" generated by a double-click.
    if (event && event.detail !== 2) {
        // Allow a repaint to occur before removing this class, so the animation
        // shows for tap events, which seem to trigger a mouseup too soon after
        // mousedown.
        window.setTimeout(function () {
            this.rippleElement_.classList.remove(this.CssClasses_.IS_VISIBLE);
        }.bind(this), 0);
    }
};
/**
   * Initialize element.
   */
MaterialRipple.prototype.init = function () {
    if (this.element_) {
        var recentering = this.element_.classList.contains(this.CssClasses_.RIPPLE_CENTER);
        if (!this.element_.classList.contains(this.CssClasses_.RIPPLE_EFFECT_IGNORE_EVENTS)) {
            this.rippleElement_ = this.element_.querySelector('.' + this.CssClasses_.RIPPLE);
            this.frameCount_ = 0;
            this.rippleSize_ = 0;
            this.x_ = 0;
            this.y_ = 0;
            // Touch start produces a compat mouse down event, which would cause a
            // second ripples. To avoid that, we use this property to ignore the first
            // mouse down after a touch start.
            this.ignoringMouseDown_ = false;
            this.boundDownHandler = this.downHandler_.bind(this);
            this.element_.addEventListener('mousedown', this.boundDownHandler);
            this.element_.addEventListener('touchstart', this.boundDownHandler);
            this.boundUpHandler = this.upHandler_.bind(this);
            this.element_.addEventListener('mouseup', this.boundUpHandler);
            this.element_.addEventListener('mouseleave', this.boundUpHandler);
            this.element_.addEventListener('touchend', this.boundUpHandler);
            this.element_.addEventListener('blur', this.boundUpHandler);
            /**
         * Getter for frameCount_.
         * @return {number} the frame count.
         */
            this.getFrameCount = function () {
                return this.frameCount_;
            };
            /**
         * Setter for frameCount_.
         * @param {number} fC the frame count.
         */
            this.setFrameCount = function (fC) {
                this.frameCount_ = fC;
            };
            /**
         * Getter for rippleElement_.
         * @return {Element} the ripple element.
         */
            this.getRippleElement = function () {
                return this.rippleElement_;
            };
            /**
         * Sets the ripple X and Y coordinates.
         * @param  {number} newX the new X coordinate
         * @param  {number} newY the new Y coordinate
         */
            this.setRippleXY = function (newX, newY) {
                this.x_ = newX;
                this.y_ = newY;
            };
            /**
         * Sets the ripple styles.
         * @param  {boolean} start whether or not this is the start frame.
         */
            this.setRippleStyles = function (start) {
                if (this.rippleElement_ !== null) {
                    var transformString;
                    var scale;
                    var size;
                    var offset = 'translate(' + this.x_ + 'px, ' + this.y_ + 'px)';
                    if (start) {
                        scale = this.Constant_.INITIAL_SCALE;
                        size = this.Constant_.INITIAL_SIZE;
                    } else {
                        scale = this.Constant_.FINAL_SCALE;
                        size = this.rippleSize_ + 'px';
                        if (recentering) {
                            offset = 'translate(' + this.boundWidth / 2 + 'px, ' + this.boundHeight / 2 + 'px)';
                        }
                    }
                    transformString = 'translate(-50%, -50%) ' + offset + scale;
                    this.rippleElement_.style.webkitTransform = transformString;
                    this.rippleElement_.style.msTransform = transformString;
                    this.rippleElement_.style.transform = transformString;
                    if (start) {
                        this.rippleElement_.classList.remove(this.CssClasses_.IS_ANIMATING);
                    } else {
                        this.rippleElement_.classList.add(this.CssClasses_.IS_ANIMATING);
                    }
                }
            };
            /**
         * Handles an animation frame.
         */
            this.animFrameHandler = function () {
                if (this.frameCount_-- > 0) {
                    window.requestAnimationFrame(this.animFrameHandler.bind(this));
                } else {
                    this.setRippleStyles(false);
                }
            };
        }
    }
};
// The component registers itself. It can assume componentHandler is available
// in the global scope.
componentHandler.register({
    constructor: MaterialRipple,
    classAsString: 'MaterialRipple',
    cssClass: 'mdl-js-ripple-effect',
    widget: false
});
}());
;

/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;
/******/
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			i: moduleId,
/******/ 			l: false,
/******/ 			exports: {}
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.l = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// identity function for calling harmony imports with the correct context
/******/ 	__webpack_require__.i = function(value) { return value; };
/******/
/******/ 	// define getter function for harmony exports
/******/ 	__webpack_require__.d = function(exports, name, getter) {
/******/ 		if(!__webpack_require__.o(exports, name)) {
/******/ 			Object.defineProperty(exports, name, {
/******/ 				configurable: false,
/******/ 				enumerable: true,
/******/ 				get: getter
/******/ 			});
/******/ 		}
/******/ 	};
/******/
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__webpack_require__.n = function(module) {
/******/ 		var getter = module && module.__esModule ?
/******/ 			function getDefault() { return module['default']; } :
/******/ 			function getModuleExports() { return module; };
/******/ 		__webpack_require__.d(getter, 'a', getter);
/******/ 		return getter;
/******/ 	};
/******/
/******/ 	// Object.prototype.hasOwnProperty.call
/******/ 	__webpack_require__.o = function(object, property) { return Object.prototype.hasOwnProperty.call(object, property); };
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(__webpack_require__.s = 1);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ (function(module, exports, __webpack_require__) {

!function() {
    'use strict';
    function VNode() {}
    function h(nodeName, attributes) {
        var lastSimple, child, simple, i, children = EMPTY_CHILDREN;
        for (i = arguments.length; i-- > 2; ) stack.push(arguments[i]);
        if (attributes && null != attributes.children) {
            if (!stack.length) stack.push(attributes.children);
            delete attributes.children;
        }
        while (stack.length) if ((child = stack.pop()) && void 0 !== child.pop) for (i = child.length; i--; ) stack.push(child[i]); else {
            if (child === !0 || child === !1) child = null;
            if (simple = 'function' != typeof nodeName) if (null == child) child = ''; else if ('number' == typeof child) child = String(child); else if ('string' != typeof child) simple = !1;
            if (simple && lastSimple) children[children.length - 1] += child; else if (children === EMPTY_CHILDREN) children = [ child ]; else children.push(child);
            lastSimple = simple;
        }
        var p = new VNode();
        p.nodeName = nodeName;
        p.children = children;
        p.attributes = null == attributes ? void 0 : attributes;
        p.key = null == attributes ? void 0 : attributes.key;
        if (void 0 !== options.vnode) options.vnode(p);
        return p;
    }
    function extend(obj, props) {
        for (var i in props) obj[i] = props[i];
        return obj;
    }
    function cloneElement(vnode, props) {
        return h(vnode.nodeName, extend(extend({}, vnode.attributes), props), arguments.length > 2 ? [].slice.call(arguments, 2) : vnode.children);
    }
    function enqueueRender(component) {
        if (!component.__d && (component.__d = !0) && 1 == items.push(component)) (options.debounceRendering || setTimeout)(rerender);
    }
    function rerender() {
        var p, list = items;
        items = [];
        while (p = list.pop()) if (p.__d) renderComponent(p);
    }
    function isSameNodeType(node, vnode, hydrating) {
        if ('string' == typeof vnode || 'number' == typeof vnode) return void 0 !== node.splitText;
        if ('string' == typeof vnode.nodeName) return !node._componentConstructor && isNamedNode(node, vnode.nodeName); else return hydrating || node._componentConstructor === vnode.nodeName;
    }
    function isNamedNode(node, nodeName) {
        return node.__n === nodeName || node.nodeName.toLowerCase() === nodeName.toLowerCase();
    }
    function getNodeProps(vnode) {
        var props = extend({}, vnode.attributes);
        props.children = vnode.children;
        var defaultProps = vnode.nodeName.defaultProps;
        if (void 0 !== defaultProps) for (var i in defaultProps) if (void 0 === props[i]) props[i] = defaultProps[i];
        return props;
    }
    function createNode(nodeName, isSvg) {
        var node = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', nodeName) : document.createElement(nodeName);
        node.__n = nodeName;
        return node;
    }
    function removeNode(node) {
        if (node.parentNode) node.parentNode.removeChild(node);
    }
    function setAccessor(node, name, old, value, isSvg) {
        if ('className' === name) name = 'class';
        if ('key' === name) ; else if ('ref' === name) {
            if (old) old(null);
            if (value) value(node);
        } else if ('class' === name && !isSvg) node.className = value || ''; else if ('style' === name) {
            if (!value || 'string' == typeof value || 'string' == typeof old) node.style.cssText = value || '';
            if (value && 'object' == typeof value) {
                if ('string' != typeof old) for (var i in old) if (!(i in value)) node.style[i] = '';
                for (var i in value) node.style[i] = 'number' == typeof value[i] && IS_NON_DIMENSIONAL.test(i) === !1 ? value[i] + 'px' : value[i];
            }
        } else if ('dangerouslySetInnerHTML' === name) {
            if (value) node.innerHTML = value.__html || '';
        } else if ('o' == name[0] && 'n' == name[1]) {
            var useCapture = name !== (name = name.replace(/Capture$/, ''));
            name = name.toLowerCase().substring(2);
            if (value) {
                if (!old) node.addEventListener(name, eventProxy, useCapture);
            } else node.removeEventListener(name, eventProxy, useCapture);
            (node.__l || (node.__l = {}))[name] = value;
        } else if ('list' !== name && 'type' !== name && !isSvg && name in node) {
            setProperty(node, name, null == value ? '' : value);
            if (null == value || value === !1) node.removeAttribute(name);
        } else {
            var ns = isSvg && name !== (name = name.replace(/^xlink\:?/, ''));
            if (null == value || value === !1) if (ns) node.removeAttributeNS('http://www.w3.org/1999/xlink', name.toLowerCase()); else node.removeAttribute(name); else if ('function' != typeof value) if (ns) node.setAttributeNS('http://www.w3.org/1999/xlink', name.toLowerCase(), value); else node.setAttribute(name, value);
        }
    }
    function setProperty(node, name, value) {
        try {
            node[name] = value;
        } catch (e) {}
    }
    function eventProxy(e) {
        return this.__l[e.type](options.event && options.event(e) || e);
    }
    function flushMounts() {
        var c;
        while (c = mounts.pop()) {
            if (options.afterMount) options.afterMount(c);
            if (c.componentDidMount) c.componentDidMount();
        }
    }
    function diff(dom, vnode, context, mountAll, parent, componentRoot) {
        if (!diffLevel++) {
            isSvgMode = null != parent && void 0 !== parent.ownerSVGElement;
            hydrating = null != dom && !('__preactattr_' in dom);
        }
        var ret = idiff(dom, vnode, context, mountAll, componentRoot);
        if (parent && ret.parentNode !== parent) parent.appendChild(ret);
        if (!--diffLevel) {
            hydrating = !1;
            if (!componentRoot) flushMounts();
        }
        return ret;
    }
    function idiff(dom, vnode, context, mountAll, componentRoot) {
        var out = dom, prevSvgMode = isSvgMode;
        if (null == vnode) vnode = '';
        if ('string' == typeof vnode) {
            if (dom && void 0 !== dom.splitText && dom.parentNode && (!dom._component || componentRoot)) {
                if (dom.nodeValue != vnode) dom.nodeValue = vnode;
            } else {
                out = document.createTextNode(vnode);
                if (dom) {
                    if (dom.parentNode) dom.parentNode.replaceChild(out, dom);
                    recollectNodeTree(dom, !0);
                }
            }
            out.__preactattr_ = !0;
            return out;
        }
        if ('function' == typeof vnode.nodeName) return buildComponentFromVNode(dom, vnode, context, mountAll);
        isSvgMode = 'svg' === vnode.nodeName ? !0 : 'foreignObject' === vnode.nodeName ? !1 : isSvgMode;
        if (!dom || !isNamedNode(dom, String(vnode.nodeName))) {
            out = createNode(String(vnode.nodeName), isSvgMode);
            if (dom) {
                while (dom.firstChild) out.appendChild(dom.firstChild);
                if (dom.parentNode) dom.parentNode.replaceChild(out, dom);
                recollectNodeTree(dom, !0);
            }
        }
        var fc = out.firstChild, props = out.__preactattr_ || (out.__preactattr_ = {}), vchildren = vnode.children;
        if (!hydrating && vchildren && 1 === vchildren.length && 'string' == typeof vchildren[0] && null != fc && void 0 !== fc.splitText && null == fc.nextSibling) {
            if (fc.nodeValue != vchildren[0]) fc.nodeValue = vchildren[0];
        } else if (vchildren && vchildren.length || null != fc) innerDiffNode(out, vchildren, context, mountAll, hydrating || null != props.dangerouslySetInnerHTML);
        diffAttributes(out, vnode.attributes, props);
        isSvgMode = prevSvgMode;
        return out;
    }
    function innerDiffNode(dom, vchildren, context, mountAll, isHydrating) {
        var j, c, vchild, child, originalChildren = dom.childNodes, children = [], keyed = {}, keyedLen = 0, min = 0, len = originalChildren.length, childrenLen = 0, vlen = vchildren ? vchildren.length : 0;
        if (0 !== len) for (var i = 0; i < len; i++) {
            var _child = originalChildren[i], props = _child.__preactattr_, key = vlen && props ? _child._component ? _child._component.__k : props.key : null;
            if (null != key) {
                keyedLen++;
                keyed[key] = _child;
            } else if (props || (void 0 !== _child.splitText ? isHydrating ? _child.nodeValue.trim() : !0 : isHydrating)) children[childrenLen++] = _child;
        }
        if (0 !== vlen) for (var i = 0; i < vlen; i++) {
            vchild = vchildren[i];
            child = null;
            var key = vchild.key;
            if (null != key) {
                if (keyedLen && void 0 !== keyed[key]) {
                    child = keyed[key];
                    keyed[key] = void 0;
                    keyedLen--;
                }
            } else if (!child && min < childrenLen) for (j = min; j < childrenLen; j++) if (void 0 !== children[j] && isSameNodeType(c = children[j], vchild, isHydrating)) {
                child = c;
                children[j] = void 0;
                if (j === childrenLen - 1) childrenLen--;
                if (j === min) min++;
                break;
            }
            child = idiff(child, vchild, context, mountAll);
            if (child && child !== dom) if (i >= len) dom.appendChild(child); else if (child !== originalChildren[i]) if (child === originalChildren[i + 1]) removeNode(originalChildren[i]); else dom.insertBefore(child, originalChildren[i] || null);
        }
        if (keyedLen) for (var i in keyed) if (void 0 !== keyed[i]) recollectNodeTree(keyed[i], !1);
        while (min <= childrenLen) if (void 0 !== (child = children[childrenLen--])) recollectNodeTree(child, !1);
    }
    function recollectNodeTree(node, unmountOnly) {
        var component = node._component;
        if (component) unmountComponent(component); else {
            if (null != node.__preactattr_ && node.__preactattr_.ref) node.__preactattr_.ref(null);
            if (unmountOnly === !1 || null == node.__preactattr_) removeNode(node);
            removeChildren(node);
        }
    }
    function removeChildren(node) {
        node = node.lastChild;
        while (node) {
            var next = node.previousSibling;
            recollectNodeTree(node, !0);
            node = next;
        }
    }
    function diffAttributes(dom, attrs, old) {
        var name;
        for (name in old) if ((!attrs || null == attrs[name]) && null != old[name]) setAccessor(dom, name, old[name], old[name] = void 0, isSvgMode);
        for (name in attrs) if (!('children' === name || 'innerHTML' === name || name in old && attrs[name] === ('value' === name || 'checked' === name ? dom[name] : old[name]))) setAccessor(dom, name, old[name], old[name] = attrs[name], isSvgMode);
    }
    function collectComponent(component) {
        var name = component.constructor.name;
        (components[name] || (components[name] = [])).push(component);
    }
    function createComponent(Ctor, props, context) {
        var inst, list = components[Ctor.name];
        if (Ctor.prototype && Ctor.prototype.render) {
            inst = new Ctor(props, context);
            Component.call(inst, props, context);
        } else {
            inst = new Component(props, context);
            inst.constructor = Ctor;
            inst.render = doRender;
        }
        if (list) for (var i = list.length; i--; ) if (list[i].constructor === Ctor) {
            inst.__b = list[i].__b;
            list.splice(i, 1);
            break;
        }
        return inst;
    }
    function doRender(props, state, context) {
        return this.constructor(props, context);
    }
    function setComponentProps(component, props, opts, context, mountAll) {
        if (!component.__x) {
            component.__x = !0;
            if (component.__r = props.ref) delete props.ref;
            if (component.__k = props.key) delete props.key;
            if (!component.base || mountAll) {
                if (component.componentWillMount) component.componentWillMount();
            } else if (component.componentWillReceiveProps) component.componentWillReceiveProps(props, context);
            if (context && context !== component.context) {
                if (!component.__c) component.__c = component.context;
                component.context = context;
            }
            if (!component.__p) component.__p = component.props;
            component.props = props;
            component.__x = !1;
            if (0 !== opts) if (1 === opts || options.syncComponentUpdates !== !1 || !component.base) renderComponent(component, 1, mountAll); else enqueueRender(component);
            if (component.__r) component.__r(component);
        }
    }
    function renderComponent(component, opts, mountAll, isChild) {
        if (!component.__x) {
            var rendered, inst, cbase, props = component.props, state = component.state, context = component.context, previousProps = component.__p || props, previousState = component.__s || state, previousContext = component.__c || context, isUpdate = component.base, nextBase = component.__b, initialBase = isUpdate || nextBase, initialChildComponent = component._component, skip = !1;
            if (isUpdate) {
                component.props = previousProps;
                component.state = previousState;
                component.context = previousContext;
                if (2 !== opts && component.shouldComponentUpdate && component.shouldComponentUpdate(props, state, context) === !1) skip = !0; else if (component.componentWillUpdate) component.componentWillUpdate(props, state, context);
                component.props = props;
                component.state = state;
                component.context = context;
            }
            component.__p = component.__s = component.__c = component.__b = null;
            component.__d = !1;
            if (!skip) {
                rendered = component.render(props, state, context);
                if (component.getChildContext) context = extend(extend({}, context), component.getChildContext());
                var toUnmount, base, childComponent = rendered && rendered.nodeName;
                if ('function' == typeof childComponent) {
                    var childProps = getNodeProps(rendered);
                    inst = initialChildComponent;
                    if (inst && inst.constructor === childComponent && childProps.key == inst.__k) setComponentProps(inst, childProps, 1, context, !1); else {
                        toUnmount = inst;
                        component._component = inst = createComponent(childComponent, childProps, context);
                        inst.__b = inst.__b || nextBase;
                        inst.__u = component;
                        setComponentProps(inst, childProps, 0, context, !1);
                        renderComponent(inst, 1, mountAll, !0);
                    }
                    base = inst.base;
                } else {
                    cbase = initialBase;
                    toUnmount = initialChildComponent;
                    if (toUnmount) cbase = component._component = null;
                    if (initialBase || 1 === opts) {
                        if (cbase) cbase._component = null;
                        base = diff(cbase, rendered, context, mountAll || !isUpdate, initialBase && initialBase.parentNode, !0);
                    }
                }
                if (initialBase && base !== initialBase && inst !== initialChildComponent) {
                    var baseParent = initialBase.parentNode;
                    if (baseParent && base !== baseParent) {
                        baseParent.replaceChild(base, initialBase);
                        if (!toUnmount) {
                            initialBase._component = null;
                            recollectNodeTree(initialBase, !1);
                        }
                    }
                }
                if (toUnmount) unmountComponent(toUnmount);
                component.base = base;
                if (base && !isChild) {
                    var componentRef = component, t = component;
                    while (t = t.__u) (componentRef = t).base = base;
                    base._component = componentRef;
                    base._componentConstructor = componentRef.constructor;
                }
            }
            if (!isUpdate || mountAll) mounts.unshift(component); else if (!skip) {
                flushMounts();
                if (component.componentDidUpdate) component.componentDidUpdate(previousProps, previousState, previousContext);
                if (options.afterUpdate) options.afterUpdate(component);
            }
            if (null != component.__h) while (component.__h.length) component.__h.pop().call(component);
            if (!diffLevel && !isChild) flushMounts();
        }
    }
    function buildComponentFromVNode(dom, vnode, context, mountAll) {
        var c = dom && dom._component, originalComponent = c, oldDom = dom, isDirectOwner = c && dom._componentConstructor === vnode.nodeName, isOwner = isDirectOwner, props = getNodeProps(vnode);
        while (c && !isOwner && (c = c.__u)) isOwner = c.constructor === vnode.nodeName;
        if (c && isOwner && (!mountAll || c._component)) {
            setComponentProps(c, props, 3, context, mountAll);
            dom = c.base;
        } else {
            if (originalComponent && !isDirectOwner) {
                unmountComponent(originalComponent);
                dom = oldDom = null;
            }
            c = createComponent(vnode.nodeName, props, context);
            if (dom && !c.__b) {
                c.__b = dom;
                oldDom = null;
            }
            setComponentProps(c, props, 1, context, mountAll);
            dom = c.base;
            if (oldDom && dom !== oldDom) {
                oldDom._component = null;
                recollectNodeTree(oldDom, !1);
            }
        }
        return dom;
    }
    function unmountComponent(component) {
        if (options.beforeUnmount) options.beforeUnmount(component);
        var base = component.base;
        component.__x = !0;
        if (component.componentWillUnmount) component.componentWillUnmount();
        component.base = null;
        var inner = component._component;
        if (inner) unmountComponent(inner); else if (base) {
            if (base.__preactattr_ && base.__preactattr_.ref) base.__preactattr_.ref(null);
            component.__b = base;
            removeNode(base);
            collectComponent(component);
            removeChildren(base);
        }
        if (component.__r) component.__r(null);
    }
    function Component(props, context) {
        this.__d = !0;
        this.context = context;
        this.props = props;
        this.state = this.state || {};
    }
    function render(vnode, parent, merge) {
        return diff(merge, vnode, {}, !1, parent, !1);
    }
    var options = {};
    var stack = [];
    var EMPTY_CHILDREN = [];
    var IS_NON_DIMENSIONAL = /acit|ex(?:s|g|n|p|$)|rph|ows|mnc|ntw|ine[ch]|zoo|^ord/i;
    var items = [];
    var mounts = [];
    var diffLevel = 0;
    var isSvgMode = !1;
    var hydrating = !1;
    var components = {};
    extend(Component.prototype, {
        setState: function(state, callback) {
            var s = this.state;
            if (!this.__s) this.__s = extend({}, s);
            extend(s, 'function' == typeof state ? state(s, this.props) : state);
            if (callback) (this.__h = this.__h || []).push(callback);
            enqueueRender(this);
        },
        forceUpdate: function(callback) {
            if (callback) (this.__h = this.__h || []).push(callback);
            renderComponent(this, 2);
        },
        render: function() {}
    });
    var preact = {
        h: h,
        createElement: h,
        cloneElement: cloneElement,
        Component: Component,
        render: render,
        rerender: rerender,
        options: options
    };
    if (true) module.exports = preact; else self.preact = preact;
}();
//# sourceMappingURL=preact.js.map

/***/ }),
/* 1 */
/***/ (function(module, __webpack_exports__, __webpack_require__) {

"use strict";
Object.defineProperty(__webpack_exports__, "__esModule", { value: true });
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_0_preact__ = __webpack_require__(0);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_0_preact___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_0_preact__);


jb.ui.render = __WEBPACK_IMPORTED_MODULE_0_preact__["render"];
jb.ui.h = __WEBPACK_IMPORTED_MODULE_0_preact__["h"];
jb.ui.Component = __WEBPACK_IMPORTED_MODULE_0_preact__["Component"];


/***/ })
/******/ ]);;

/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;
/******/
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			i: moduleId,
/******/ 			l: false,
/******/ 			exports: {}
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.l = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// identity function for calling harmony imports with the correct context
/******/ 	__webpack_require__.i = function(value) { return value; };
/******/
/******/ 	// define getter function for harmony exports
/******/ 	__webpack_require__.d = function(exports, name, getter) {
/******/ 		if(!__webpack_require__.o(exports, name)) {
/******/ 			Object.defineProperty(exports, name, {
/******/ 				configurable: false,
/******/ 				enumerable: true,
/******/ 				get: getter
/******/ 			});
/******/ 		}
/******/ 	};
/******/
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__webpack_require__.n = function(module) {
/******/ 		var getter = module && module.__esModule ?
/******/ 			function getDefault() { return module['default']; } :
/******/ 			function getModuleExports() { return module; };
/******/ 		__webpack_require__.d(getter, 'a', getter);
/******/ 		return getter;
/******/ 	};
/******/
/******/ 	// Object.prototype.hasOwnProperty.call
/******/ 	__webpack_require__.o = function(object, property) { return Object.prototype.hasOwnProperty.call(object, property); };
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(__webpack_require__.s = 3);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ (function(module, exports, __webpack_require__) {

var invariant = __webpack_require__(1);

var hasOwnProperty = Object.prototype.hasOwnProperty;
var splice = Array.prototype.splice;

var assign = Object.assign || function assign(target, source) {
  var keys = getAllKeys(source);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (hasOwnProperty.call(source, key)) {
      target[key] = source[key];
    }
  }
  return target;
}

var getAllKeys = typeof Object.getOwnPropertySymbols === 'function' ?
  function(obj) { return Object.keys(obj).concat(Object.getOwnPropertySymbols(obj)) } :
  function(obj) { return Object.keys(obj) }
;

function copy(object) {
  if (object instanceof Array) {
    return object.slice();
  } else if (object && typeof object === 'object') {
    return assign(new object.constructor(), object);
  } else {
    return object;
  }
}


function newContext() {
  var commands = assign({}, defaultCommands);
  update.extend = function(directive, fn) {
    commands[directive] = fn;
  }

  return update;

  function update(object, spec) {
    invariant(
      !Array.isArray(spec),
      'update(): You provided an invalid spec to update(). The spec may ' +
      'not contain an array except as the value of $set, $push, $unshift, ' +
      '$splice or any custom command allowing an array value.'
    );

    invariant(
      typeof spec === 'object' && spec !== null,
      'update(): You provided an invalid spec to update(). The spec and ' +
      'every included key path must be plain objects containing one of the ' +
      'following commands: %s.',
      Object.keys(commands).join(', ')
    );

    var nextObject = object;
    var specKeys = getAllKeys(spec)
    var index, key;
    for (index = 0; index < specKeys.length; index++) {
      var key = specKeys[index];
      if (hasOwnProperty.call(commands, key)) {
        nextObject = commands[key](spec[key], nextObject, spec, object);
      } else {
        var nextValueForKey = update(object[key], spec[key]);
        if (nextValueForKey !== nextObject[key]) {
          if (nextObject === object) {
            nextObject = copy(object);
          }
          nextObject[key] = nextValueForKey;
        }
      }
    }
    return nextObject;
  }

}

var defaultCommands = {
  $push: function(value, original, spec) {
    invariantPushAndUnshift(original, spec, '$push');
    return original.concat(value);
  },
  $unshift: function(value, original, spec) {
    invariantPushAndUnshift(original, spec, '$unshift');
    return value.concat(original);
  },
  $splice: function(value, nextObject, spec, object) {
    var originalValue = nextObject === object ? copy(object) : nextObject;
    invariantSplices(originalValue, spec);
    value.forEach(function(args) {
      invariantSplice(args);
      splice.apply(originalValue, args);
    });
    return originalValue;
  },
  $set: function(value, original, spec) {
    invariantSet(spec);
    return value;
  },
  $merge: function(value, nextObject, spec, object) {
    var originalValue = nextObject === object ? copy(object) : nextObject;
    invariantMerge(originalValue, value);
    getAllKeys(value).forEach(function(key) {
      originalValue[key] = value[key];
    });
    return originalValue;
  },
  $apply: function(value, original) {
    invariantApply(value);
    return value(original);
  }
};



module.exports = newContext();
module.exports.newContext = newContext;


// invariants

function invariantPushAndUnshift(value, spec, command) {
  invariant(
    Array.isArray(value),
    'update(): expected target of %s to be an array; got %s.',
    command,
    value
  );
  var specValue = spec[command];
  invariant(
    Array.isArray(specValue),
    'update(): expected spec of %s to be an array; got %s. ' +
    'Did you forget to wrap your parameter in an array?',
    command,
    specValue
  );
}

function invariantSplices(value, spec) {
  invariant(
    Array.isArray(value),
    'Expected $splice target to be an array; got %s',
    value
  );
  invariantSplice(spec['$splice']);
}

function invariantSplice(value) {
  invariant(
    Array.isArray(value),
    'update(): expected spec of $splice to be an array of arrays; got %s. ' +
    'Did you forget to wrap your parameters in an array?',
    value
  );
}

function invariantApply(fn) {
  invariant(
    typeof fn === 'function',
    'update(): expected spec of $apply to be a function; got %s.',
    fn
  );
}

function invariantSet(spec) {
  invariant(
    Object.keys(spec).length === 1,
    'Cannot have more than one key in an object with $set'
  );
}

function invariantMerge(target, specValue) {
  invariant(
    specValue && typeof specValue === 'object',
    'update(): $merge expects a spec of type \'object\'; got %s',
    specValue
  );
  invariant(
    target && typeof target === 'object',
    'update(): $merge expects a target of type \'object\'; got %s',
    target
  );
}


/***/ }),
/* 1 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";
/* WEBPACK VAR INJECTION */(function(process) {/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */



/**
 * Use invariant() to assert state which your program assumes to be true.
 *
 * Provide sprintf-style format (only %s is supported) and arguments
 * to provide information about what broke and what you were
 * expecting.
 *
 * The invariant message will be stripped in production, but the invariant
 * will remain to ensure logic does not differ in production.
 */

var invariant = function(condition, format, a, b, c, d, e, f) {
  if (process.env.NODE_ENV !== 'production') {
    if (format === undefined) {
      throw new Error('invariant requires an error message argument');
    }
  }

  if (!condition) {
    var error;
    if (format === undefined) {
      error = new Error(
        'Minified exception occurred; use the non-minified dev environment ' +
        'for the full error message and additional helpful warnings.'
      );
    } else {
      var args = [a, b, c, d, e, f];
      var argIndex = 0;
      error = new Error(
        format.replace(/%s/g, function() { return args[argIndex++]; })
      );
      error.name = 'Invariant Violation';
    }

    error.framesToPop = 1; // we don't care about invariant's own frame
    throw error;
  }
};

module.exports = invariant;

/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(2)))

/***/ }),
/* 2 */
/***/ (function(module, exports) {

// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };


/***/ }),
/* 3 */
/***/ (function(module, __webpack_exports__, __webpack_require__) {

"use strict";
Object.defineProperty(__webpack_exports__, "__esModule", { value: true });
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_0_immutability_helper__ = __webpack_require__(0);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_0_immutability_helper___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_0_immutability_helper__);


jb.ui.update = __WEBPACK_IMPORTED_MODULE_0_immutability_helper___default.a;


/***/ })
/******/ ]);;

/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;
/******/
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			i: moduleId,
/******/ 			l: false,
/******/ 			exports: {}
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.l = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// identity function for calling harmony imports with the correct context
/******/ 	__webpack_require__.i = function(value) { return value; };
/******/
/******/ 	// define getter function for harmony exports
/******/ 	__webpack_require__.d = function(exports, name, getter) {
/******/ 		if(!__webpack_require__.o(exports, name)) {
/******/ 			Object.defineProperty(exports, name, {
/******/ 				configurable: false,
/******/ 				enumerable: true,
/******/ 				get: getter
/******/ 			});
/******/ 		}
/******/ 	};
/******/
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__webpack_require__.n = function(module) {
/******/ 		var getter = module && module.__esModule ?
/******/ 			function getDefault() { return module['default']; } :
/******/ 			function getModuleExports() { return module; };
/******/ 		__webpack_require__.d(getter, 'a', getter);
/******/ 		return getter;
/******/ 	};
/******/
/******/ 	// Object.prototype.hasOwnProperty.call
/******/ 	__webpack_require__.o = function(object, property) { return Object.prototype.hasOwnProperty.call(object, property); };
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(__webpack_require__.s = 98);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var root_1 = __webpack_require__(2);
var toSubscriber_1 = __webpack_require__(96);
var observable_1 = __webpack_require__(15);
/**
 * A representation of any set of values over any amount of time. This the most basic building block
 * of RxJS.
 *
 * @class Observable<T>
 */
var Observable = (function () {
    /**
     * @constructor
     * @param {Function} subscribe the function that is  called when the Observable is
     * initially subscribed to. This function is given a Subscriber, to which new values
     * can be `next`ed, or an `error` method can be called to raise an error, or
     * `complete` can be called to notify of a successful completion.
     */
    function Observable(subscribe) {
        this._isScalar = false;
        if (subscribe) {
            this._subscribe = subscribe;
        }
    }
    /**
     * Creates a new Observable, with this Observable as the source, and the passed
     * operator defined as the new observable's operator.
     * @method lift
     * @param {Operator} operator the operator defining the operation to take on the observable
     * @return {Observable} a new observable with the Operator applied
     */
    Observable.prototype.lift = function (operator) {
        var observable = new Observable();
        observable.source = this;
        observable.operator = operator;
        return observable;
    };
    Observable.prototype.subscribe = function (observerOrNext, error, complete) {
        var operator = this.operator;
        var sink = toSubscriber_1.toSubscriber(observerOrNext, error, complete);
        if (operator) {
            operator.call(sink, this.source);
        }
        else {
            sink.add(this._trySubscribe(sink));
        }
        if (sink.syncErrorThrowable) {
            sink.syncErrorThrowable = false;
            if (sink.syncErrorThrown) {
                throw sink.syncErrorValue;
            }
        }
        return sink;
    };
    Observable.prototype._trySubscribe = function (sink) {
        try {
            return this._subscribe(sink);
        }
        catch (err) {
            sink.syncErrorThrown = true;
            sink.syncErrorValue = err;
            sink.error(err);
        }
    };
    /**
     * @method forEach
     * @param {Function} next a handler for each value emitted by the observable
     * @param {PromiseConstructor} [PromiseCtor] a constructor function used to instantiate the Promise
     * @return {Promise} a promise that either resolves on observable completion or
     *  rejects with the handled error
     */
    Observable.prototype.forEach = function (next, PromiseCtor) {
        var _this = this;
        if (!PromiseCtor) {
            if (root_1.root.Rx && root_1.root.Rx.config && root_1.root.Rx.config.Promise) {
                PromiseCtor = root_1.root.Rx.config.Promise;
            }
            else if (root_1.root.Promise) {
                PromiseCtor = root_1.root.Promise;
            }
        }
        if (!PromiseCtor) {
            throw new Error('no Promise impl found');
        }
        return new PromiseCtor(function (resolve, reject) {
            // Must be declared in a separate statement to avoid a RefernceError when
            // accessing subscription below in the closure due to Temporal Dead Zone.
            var subscription;
            subscription = _this.subscribe(function (value) {
                if (subscription) {
                    // if there is a subscription, then we can surmise
                    // the next handling is asynchronous. Any errors thrown
                    // need to be rejected explicitly and unsubscribe must be
                    // called manually
                    try {
                        next(value);
                    }
                    catch (err) {
                        reject(err);
                        subscription.unsubscribe();
                    }
                }
                else {
                    // if there is NO subscription, then we're getting a nexted
                    // value synchronously during subscription. We can just call it.
                    // If it errors, Observable's `subscribe` will ensure the
                    // unsubscription logic is called, then synchronously rethrow the error.
                    // After that, Promise will trap the error and send it
                    // down the rejection path.
                    next(value);
                }
            }, reject, resolve);
        });
    };
    Observable.prototype._subscribe = function (subscriber) {
        return this.source.subscribe(subscriber);
    };
    /**
     * An interop point defined by the es7-observable spec https://github.com/zenparsing/es-observable
     * @method Symbol.observable
     * @return {Observable} this instance of the observable
     */
    Observable.prototype[observable_1.observable] = function () {
        return this;
    };
    // HACK: Since TypeScript inherits static properties too, we have to
    // fight against TypeScript here so Subject can have a different static create signature
    /**
     * Creates a new cold Observable by calling the Observable constructor
     * @static true
     * @owner Observable
     * @method create
     * @param {Function} subscribe? the subscriber function to be passed to the Observable constructor
     * @return {Observable} a new cold observable
     */
    Observable.create = function (subscribe) {
        return new Observable(subscribe);
    };
    return Observable;
}());
exports.Observable = Observable;
//# sourceMappingURL=Observable.js.map

/***/ }),
/* 1 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var isFunction_1 = __webpack_require__(17);
var Subscription_1 = __webpack_require__(4);
var Observer_1 = __webpack_require__(21);
var rxSubscriber_1 = __webpack_require__(16);
/**
 * Implements the {@link Observer} interface and extends the
 * {@link Subscription} class. While the {@link Observer} is the public API for
 * consuming the values of an {@link Observable}, all Observers get converted to
 * a Subscriber, in order to provide Subscription-like capabilities such as
 * `unsubscribe`. Subscriber is a common type in RxJS, and crucial for
 * implementing operators, but it is rarely used as a public API.
 *
 * @class Subscriber<T>
 */
var Subscriber = (function (_super) {
    __extends(Subscriber, _super);
    /**
     * @param {Observer|function(value: T): void} [destinationOrNext] A partially
     * defined Observer or a `next` callback function.
     * @param {function(e: ?any): void} [error] The `error` callback of an
     * Observer.
     * @param {function(): void} [complete] The `complete` callback of an
     * Observer.
     */
    function Subscriber(destinationOrNext, error, complete) {
        _super.call(this);
        this.syncErrorValue = null;
        this.syncErrorThrown = false;
        this.syncErrorThrowable = false;
        this.isStopped = false;
        switch (arguments.length) {
            case 0:
                this.destination = Observer_1.empty;
                break;
            case 1:
                if (!destinationOrNext) {
                    this.destination = Observer_1.empty;
                    break;
                }
                if (typeof destinationOrNext === 'object') {
                    if (destinationOrNext instanceof Subscriber) {
                        this.destination = destinationOrNext;
                        this.destination.add(this);
                    }
                    else {
                        this.syncErrorThrowable = true;
                        this.destination = new SafeSubscriber(this, destinationOrNext);
                    }
                    break;
                }
            default:
                this.syncErrorThrowable = true;
                this.destination = new SafeSubscriber(this, destinationOrNext, error, complete);
                break;
        }
    }
    Subscriber.prototype[rxSubscriber_1.rxSubscriber] = function () { return this; };
    /**
     * A static factory for a Subscriber, given a (potentially partial) definition
     * of an Observer.
     * @param {function(x: ?T): void} [next] The `next` callback of an Observer.
     * @param {function(e: ?any): void} [error] The `error` callback of an
     * Observer.
     * @param {function(): void} [complete] The `complete` callback of an
     * Observer.
     * @return {Subscriber<T>} A Subscriber wrapping the (partially defined)
     * Observer represented by the given arguments.
     */
    Subscriber.create = function (next, error, complete) {
        var subscriber = new Subscriber(next, error, complete);
        subscriber.syncErrorThrowable = false;
        return subscriber;
    };
    /**
     * The {@link Observer} callback to receive notifications of type `next` from
     * the Observable, with a value. The Observable may call this method 0 or more
     * times.
     * @param {T} [value] The `next` value.
     * @return {void}
     */
    Subscriber.prototype.next = function (value) {
        if (!this.isStopped) {
            this._next(value);
        }
    };
    /**
     * The {@link Observer} callback to receive notifications of type `error` from
     * the Observable, with an attached {@link Error}. Notifies the Observer that
     * the Observable has experienced an error condition.
     * @param {any} [err] The `error` exception.
     * @return {void}
     */
    Subscriber.prototype.error = function (err) {
        if (!this.isStopped) {
            this.isStopped = true;
            this._error(err);
        }
    };
    /**
     * The {@link Observer} callback to receive a valueless notification of type
     * `complete` from the Observable. Notifies the Observer that the Observable
     * has finished sending push-based notifications.
     * @return {void}
     */
    Subscriber.prototype.complete = function () {
        if (!this.isStopped) {
            this.isStopped = true;
            this._complete();
        }
    };
    Subscriber.prototype.unsubscribe = function () {
        if (this.closed) {
            return;
        }
        this.isStopped = true;
        _super.prototype.unsubscribe.call(this);
    };
    Subscriber.prototype._next = function (value) {
        this.destination.next(value);
    };
    Subscriber.prototype._error = function (err) {
        this.destination.error(err);
        this.unsubscribe();
    };
    Subscriber.prototype._complete = function () {
        this.destination.complete();
        this.unsubscribe();
    };
    Subscriber.prototype._unsubscribeAndRecycle = function () {
        var _a = this, _parent = _a._parent, _parents = _a._parents;
        this._parent = null;
        this._parents = null;
        this.unsubscribe();
        this.closed = false;
        this.isStopped = false;
        this._parent = _parent;
        this._parents = _parents;
        return this;
    };
    return Subscriber;
}(Subscription_1.Subscription));
exports.Subscriber = Subscriber;
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var SafeSubscriber = (function (_super) {
    __extends(SafeSubscriber, _super);
    function SafeSubscriber(_parentSubscriber, observerOrNext, error, complete) {
        _super.call(this);
        this._parentSubscriber = _parentSubscriber;
        var next;
        var context = this;
        if (isFunction_1.isFunction(observerOrNext)) {
            next = observerOrNext;
        }
        else if (observerOrNext) {
            next = observerOrNext.next;
            error = observerOrNext.error;
            complete = observerOrNext.complete;
            if (observerOrNext !== Observer_1.empty) {
                context = Object.create(observerOrNext);
                if (isFunction_1.isFunction(context.unsubscribe)) {
                    this.add(context.unsubscribe.bind(context));
                }
                context.unsubscribe = this.unsubscribe.bind(this);
            }
        }
        this._context = context;
        this._next = next;
        this._error = error;
        this._complete = complete;
    }
    SafeSubscriber.prototype.next = function (value) {
        if (!this.isStopped && this._next) {
            var _parentSubscriber = this._parentSubscriber;
            if (!_parentSubscriber.syncErrorThrowable) {
                this.__tryOrUnsub(this._next, value);
            }
            else if (this.__tryOrSetError(_parentSubscriber, this._next, value)) {
                this.unsubscribe();
            }
        }
    };
    SafeSubscriber.prototype.error = function (err) {
        if (!this.isStopped) {
            var _parentSubscriber = this._parentSubscriber;
            if (this._error) {
                if (!_parentSubscriber.syncErrorThrowable) {
                    this.__tryOrUnsub(this._error, err);
                    this.unsubscribe();
                }
                else {
                    this.__tryOrSetError(_parentSubscriber, this._error, err);
                    this.unsubscribe();
                }
            }
            else if (!_parentSubscriber.syncErrorThrowable) {
                this.unsubscribe();
                throw err;
            }
            else {
                _parentSubscriber.syncErrorValue = err;
                _parentSubscriber.syncErrorThrown = true;
                this.unsubscribe();
            }
        }
    };
    SafeSubscriber.prototype.complete = function () {
        if (!this.isStopped) {
            var _parentSubscriber = this._parentSubscriber;
            if (this._complete) {
                if (!_parentSubscriber.syncErrorThrowable) {
                    this.__tryOrUnsub(this._complete);
                    this.unsubscribe();
                }
                else {
                    this.__tryOrSetError(_parentSubscriber, this._complete);
                    this.unsubscribe();
                }
            }
            else {
                this.unsubscribe();
            }
        }
    };
    SafeSubscriber.prototype.__tryOrUnsub = function (fn, value) {
        try {
            fn.call(this._context, value);
        }
        catch (err) {
            this.unsubscribe();
            throw err;
        }
    };
    SafeSubscriber.prototype.__tryOrSetError = function (parent, fn, value) {
        try {
            fn.call(this._context, value);
        }
        catch (err) {
            parent.syncErrorValue = err;
            parent.syncErrorThrown = true;
            return true;
        }
        return false;
    };
    SafeSubscriber.prototype._unsubscribe = function () {
        var _parentSubscriber = this._parentSubscriber;
        this._context = null;
        this._parentSubscriber = null;
        _parentSubscriber.unsubscribe();
    };
    return SafeSubscriber;
}(Subscriber));
//# sourceMappingURL=Subscriber.js.map

/***/ }),
/* 2 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";
/* WEBPACK VAR INJECTION */(function(global) {
/**
 * window: browser in DOM main thread
 * self: browser in WebWorker
 * global: Node.js/other
 */
exports.root = (typeof window == 'object' && window.window === window && window
    || typeof self == 'object' && self.self === self && self
    || typeof global == 'object' && global.global === global && global);
if (!exports.root) {
    throw new Error('RxJS could not find any global context (window, self, global)');
}
//# sourceMappingURL=root.js.map
/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(97)))

/***/ }),
/* 3 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var OuterSubscriber = (function (_super) {
    __extends(OuterSubscriber, _super);
    function OuterSubscriber() {
        _super.apply(this, arguments);
    }
    OuterSubscriber.prototype.notifyNext = function (outerValue, innerValue, outerIndex, innerIndex, innerSub) {
        this.destination.next(innerValue);
    };
    OuterSubscriber.prototype.notifyError = function (error, innerSub) {
        this.destination.error(error);
    };
    OuterSubscriber.prototype.notifyComplete = function (innerSub) {
        this.destination.complete();
    };
    return OuterSubscriber;
}(Subscriber_1.Subscriber));
exports.OuterSubscriber = OuterSubscriber;
//# sourceMappingURL=OuterSubscriber.js.map

/***/ }),
/* 4 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var isArray_1 = __webpack_require__(9);
var isObject_1 = __webpack_require__(27);
var isFunction_1 = __webpack_require__(17);
var tryCatch_1 = __webpack_require__(18);
var errorObject_1 = __webpack_require__(8);
var UnsubscriptionError_1 = __webpack_require__(93);
/**
 * Represents a disposable resource, such as the execution of an Observable. A
 * Subscription has one important method, `unsubscribe`, that takes no argument
 * and just disposes the resource held by the subscription.
 *
 * Additionally, subscriptions may be grouped together through the `add()`
 * method, which will attach a child Subscription to the current Subscription.
 * When a Subscription is unsubscribed, all its children (and its grandchildren)
 * will be unsubscribed as well.
 *
 * @class Subscription
 */
var Subscription = (function () {
    /**
     * @param {function(): void} [unsubscribe] A function describing how to
     * perform the disposal of resources when the `unsubscribe` method is called.
     */
    function Subscription(unsubscribe) {
        /**
         * A flag to indicate whether this Subscription has already been unsubscribed.
         * @type {boolean}
         */
        this.closed = false;
        this._parent = null;
        this._parents = null;
        this._subscriptions = null;
        if (unsubscribe) {
            this._unsubscribe = unsubscribe;
        }
    }
    /**
     * Disposes the resources held by the subscription. May, for instance, cancel
     * an ongoing Observable execution or cancel any other type of work that
     * started when the Subscription was created.
     * @return {void}
     */
    Subscription.prototype.unsubscribe = function () {
        var hasErrors = false;
        var errors;
        if (this.closed) {
            return;
        }
        var _a = this, _parent = _a._parent, _parents = _a._parents, _unsubscribe = _a._unsubscribe, _subscriptions = _a._subscriptions;
        this.closed = true;
        this._parent = null;
        this._parents = null;
        // null out _subscriptions first so any child subscriptions that attempt
        // to remove themselves from this subscription will noop
        this._subscriptions = null;
        var index = -1;
        var len = _parents ? _parents.length : 0;
        // if this._parent is null, then so is this._parents, and we
        // don't have to remove ourselves from any parent subscriptions.
        while (_parent) {
            _parent.remove(this);
            // if this._parents is null or index >= len,
            // then _parent is set to null, and the loop exits
            _parent = ++index < len && _parents[index] || null;
        }
        if (isFunction_1.isFunction(_unsubscribe)) {
            var trial = tryCatch_1.tryCatch(_unsubscribe).call(this);
            if (trial === errorObject_1.errorObject) {
                hasErrors = true;
                errors = errors || (errorObject_1.errorObject.e instanceof UnsubscriptionError_1.UnsubscriptionError ?
                    flattenUnsubscriptionErrors(errorObject_1.errorObject.e.errors) : [errorObject_1.errorObject.e]);
            }
        }
        if (isArray_1.isArray(_subscriptions)) {
            index = -1;
            len = _subscriptions.length;
            while (++index < len) {
                var sub = _subscriptions[index];
                if (isObject_1.isObject(sub)) {
                    var trial = tryCatch_1.tryCatch(sub.unsubscribe).call(sub);
                    if (trial === errorObject_1.errorObject) {
                        hasErrors = true;
                        errors = errors || [];
                        var err = errorObject_1.errorObject.e;
                        if (err instanceof UnsubscriptionError_1.UnsubscriptionError) {
                            errors = errors.concat(flattenUnsubscriptionErrors(err.errors));
                        }
                        else {
                            errors.push(err);
                        }
                    }
                }
            }
        }
        if (hasErrors) {
            throw new UnsubscriptionError_1.UnsubscriptionError(errors);
        }
    };
    /**
     * Adds a tear down to be called during the unsubscribe() of this
     * Subscription.
     *
     * If the tear down being added is a subscription that is already
     * unsubscribed, is the same reference `add` is being called on, or is
     * `Subscription.EMPTY`, it will not be added.
     *
     * If this subscription is already in an `closed` state, the passed
     * tear down logic will be executed immediately.
     *
     * @param {TeardownLogic} teardown The additional logic to execute on
     * teardown.
     * @return {Subscription} Returns the Subscription used or created to be
     * added to the inner subscriptions list. This Subscription can be used with
     * `remove()` to remove the passed teardown logic from the inner subscriptions
     * list.
     */
    Subscription.prototype.add = function (teardown) {
        if (!teardown || (teardown === Subscription.EMPTY)) {
            return Subscription.EMPTY;
        }
        if (teardown === this) {
            return this;
        }
        var subscription = teardown;
        switch (typeof teardown) {
            case 'function':
                subscription = new Subscription(teardown);
            case 'object':
                if (subscription.closed || typeof subscription.unsubscribe !== 'function') {
                    return subscription;
                }
                else if (this.closed) {
                    subscription.unsubscribe();
                    return subscription;
                }
                else if (typeof subscription._addParent !== 'function' /* quack quack */) {
                    var tmp = subscription;
                    subscription = new Subscription();
                    subscription._subscriptions = [tmp];
                }
                break;
            default:
                throw new Error('unrecognized teardown ' + teardown + ' added to Subscription.');
        }
        var subscriptions = this._subscriptions || (this._subscriptions = []);
        subscriptions.push(subscription);
        subscription._addParent(this);
        return subscription;
    };
    /**
     * Removes a Subscription from the internal list of subscriptions that will
     * unsubscribe during the unsubscribe process of this Subscription.
     * @param {Subscription} subscription The subscription to remove.
     * @return {void}
     */
    Subscription.prototype.remove = function (subscription) {
        var subscriptions = this._subscriptions;
        if (subscriptions) {
            var subscriptionIndex = subscriptions.indexOf(subscription);
            if (subscriptionIndex !== -1) {
                subscriptions.splice(subscriptionIndex, 1);
            }
        }
    };
    Subscription.prototype._addParent = function (parent) {
        var _a = this, _parent = _a._parent, _parents = _a._parents;
        if (!_parent || _parent === parent) {
            // If we don't have a parent, or the new parent is the same as the
            // current parent, then set this._parent to the new parent.
            this._parent = parent;
        }
        else if (!_parents) {
            // If there's already one parent, but not multiple, allocate an Array to
            // store the rest of the parent Subscriptions.
            this._parents = [parent];
        }
        else if (_parents.indexOf(parent) === -1) {
            // Only add the new parent to the _parents list if it's not already there.
            _parents.push(parent);
        }
    };
    Subscription.EMPTY = (function (empty) {
        empty.closed = true;
        return empty;
    }(new Subscription()));
    return Subscription;
}());
exports.Subscription = Subscription;
function flattenUnsubscriptionErrors(errors) {
    return errors.reduce(function (errs, err) { return errs.concat((err instanceof UnsubscriptionError_1.UnsubscriptionError) ? err.errors : err); }, []);
}
//# sourceMappingURL=Subscription.js.map

/***/ }),
/* 5 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Observable_1 = __webpack_require__(0);
var ScalarObservable_1 = __webpack_require__(12);
var EmptyObservable_1 = __webpack_require__(7);
var isScheduler_1 = __webpack_require__(10);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @extends {Ignored}
 * @hide true
 */
var ArrayObservable = (function (_super) {
    __extends(ArrayObservable, _super);
    function ArrayObservable(array, scheduler) {
        _super.call(this);
        this.array = array;
        this.scheduler = scheduler;
        if (!scheduler && array.length === 1) {
            this._isScalar = true;
            this.value = array[0];
        }
    }
    ArrayObservable.create = function (array, scheduler) {
        return new ArrayObservable(array, scheduler);
    };
    /**
     * Creates an Observable that emits some values you specify as arguments,
     * immediately one after the other, and then emits a complete notification.
     *
     * <span class="informal">Emits the arguments you provide, then completes.
     * </span>
     *
     * <img src="./img/of.png" width="100%">
     *
     * This static operator is useful for creating a simple Observable that only
     * emits the arguments given, and the complete notification thereafter. It can
     * be used for composing with other Observables, such as with {@link concat}.
     * By default, it uses a `null` IScheduler, which means the `next`
     * notifications are sent synchronously, although with a different IScheduler
     * it is possible to determine when those notifications will be delivered.
     *
     * @example <caption>Emit 10, 20, 30, then 'a', 'b', 'c', then start ticking every second.</caption>
     * var numbers = Rx.Observable.of(10, 20, 30);
     * var letters = Rx.Observable.of('a', 'b', 'c');
     * var interval = Rx.Observable.interval(1000);
     * var result = numbers.concat(letters).concat(interval);
     * result.subscribe(x => console.log(x));
     *
     * @see {@link create}
     * @see {@link empty}
     * @see {@link never}
     * @see {@link throw}
     *
     * @param {...T} values Arguments that represent `next` values to be emitted.
     * @param {Scheduler} [scheduler] A {@link IScheduler} to use for scheduling
     * the emissions of the `next` notifications.
     * @return {Observable<T>} An Observable that emits each given input value.
     * @static true
     * @name of
     * @owner Observable
     */
    ArrayObservable.of = function () {
        var array = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            array[_i - 0] = arguments[_i];
        }
        var scheduler = array[array.length - 1];
        if (isScheduler_1.isScheduler(scheduler)) {
            array.pop();
        }
        else {
            scheduler = null;
        }
        var len = array.length;
        if (len > 1) {
            return new ArrayObservable(array, scheduler);
        }
        else if (len === 1) {
            return new ScalarObservable_1.ScalarObservable(array[0], scheduler);
        }
        else {
            return new EmptyObservable_1.EmptyObservable(scheduler);
        }
    };
    ArrayObservable.dispatch = function (state) {
        var array = state.array, index = state.index, count = state.count, subscriber = state.subscriber;
        if (index >= count) {
            subscriber.complete();
            return;
        }
        subscriber.next(array[index]);
        if (subscriber.closed) {
            return;
        }
        state.index = index + 1;
        this.schedule(state);
    };
    ArrayObservable.prototype._subscribe = function (subscriber) {
        var index = 0;
        var array = this.array;
        var count = array.length;
        var scheduler = this.scheduler;
        if (scheduler) {
            return scheduler.schedule(ArrayObservable.dispatch, 0, {
                array: array, index: index, count: count, subscriber: subscriber
            });
        }
        else {
            for (var i = 0; i < count && !subscriber.closed; i++) {
                subscriber.next(array[i]);
            }
            subscriber.complete();
        }
    };
    return ArrayObservable;
}(Observable_1.Observable));
exports.ArrayObservable = ArrayObservable;
//# sourceMappingURL=ArrayObservable.js.map

/***/ }),
/* 6 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var root_1 = __webpack_require__(2);
var isArrayLike_1 = __webpack_require__(26);
var isPromise_1 = __webpack_require__(28);
var isObject_1 = __webpack_require__(27);
var Observable_1 = __webpack_require__(0);
var iterator_1 = __webpack_require__(14);
var InnerSubscriber_1 = __webpack_require__(55);
var observable_1 = __webpack_require__(15);
function subscribeToResult(outerSubscriber, result, outerValue, outerIndex) {
    var destination = new InnerSubscriber_1.InnerSubscriber(outerSubscriber, outerValue, outerIndex);
    if (destination.closed) {
        return null;
    }
    if (result instanceof Observable_1.Observable) {
        if (result._isScalar) {
            destination.next(result.value);
            destination.complete();
            return null;
        }
        else {
            return result.subscribe(destination);
        }
    }
    else if (isArrayLike_1.isArrayLike(result)) {
        for (var i = 0, len = result.length; i < len && !destination.closed; i++) {
            destination.next(result[i]);
        }
        if (!destination.closed) {
            destination.complete();
        }
    }
    else if (isPromise_1.isPromise(result)) {
        result.then(function (value) {
            if (!destination.closed) {
                destination.next(value);
                destination.complete();
            }
        }, function (err) { return destination.error(err); })
            .then(null, function (err) {
            // Escaping the Promise trap: globally throw unhandled errors
            root_1.root.setTimeout(function () { throw err; });
        });
        return destination;
    }
    else if (result && typeof result[iterator_1.iterator] === 'function') {
        var iterator = result[iterator_1.iterator]();
        do {
            var item = iterator.next();
            if (item.done) {
                destination.complete();
                break;
            }
            destination.next(item.value);
            if (destination.closed) {
                break;
            }
        } while (true);
    }
    else if (result && typeof result[observable_1.observable] === 'function') {
        var obs = result[observable_1.observable]();
        if (typeof obs.subscribe !== 'function') {
            destination.error(new TypeError('Provided object does not correctly implement Symbol.observable'));
        }
        else {
            return obs.subscribe(new InnerSubscriber_1.InnerSubscriber(outerSubscriber, outerValue, outerIndex));
        }
    }
    else {
        var value = isObject_1.isObject(result) ? 'an invalid object' : "'" + result + "'";
        var msg = ("You provided " + value + " where a stream was expected.")
            + ' You can provide an Observable, Promise, Array, or Iterable.';
        destination.error(new TypeError(msg));
    }
    return null;
}
exports.subscribeToResult = subscribeToResult;
//# sourceMappingURL=subscribeToResult.js.map

/***/ }),
/* 7 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Observable_1 = __webpack_require__(0);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @extends {Ignored}
 * @hide true
 */
var EmptyObservable = (function (_super) {
    __extends(EmptyObservable, _super);
    function EmptyObservable(scheduler) {
        _super.call(this);
        this.scheduler = scheduler;
    }
    /**
     * Creates an Observable that emits no items to the Observer and immediately
     * emits a complete notification.
     *
     * <span class="informal">Just emits 'complete', and nothing else.
     * </span>
     *
     * <img src="./img/empty.png" width="100%">
     *
     * This static operator is useful for creating a simple Observable that only
     * emits the complete notification. It can be used for composing with other
     * Observables, such as in a {@link mergeMap}.
     *
     * @example <caption>Emit the number 7, then complete.</caption>
     * var result = Rx.Observable.empty().startWith(7);
     * result.subscribe(x => console.log(x));
     *
     * @example <caption>Map and flatten only odd numbers to the sequence 'a', 'b', 'c'</caption>
     * var interval = Rx.Observable.interval(1000);
     * var result = interval.mergeMap(x =>
     *   x % 2 === 1 ? Rx.Observable.of('a', 'b', 'c') : Rx.Observable.empty()
     * );
     * result.subscribe(x => console.log(x));
     *
     * // Results in the following to the console:
     * // x is equal to the count on the interval eg(0,1,2,3,...)
     * // x will occur every 1000ms
     * // if x % 2 is equal to 1 print abc
     * // if x % 2 is not equal to 1 nothing will be output
     *
     * @see {@link create}
     * @see {@link never}
     * @see {@link of}
     * @see {@link throw}
     *
     * @param {Scheduler} [scheduler] A {@link IScheduler} to use for scheduling
     * the emission of the complete notification.
     * @return {Observable} An "empty" Observable: emits only the complete
     * notification.
     * @static true
     * @name empty
     * @owner Observable
     */
    EmptyObservable.create = function (scheduler) {
        return new EmptyObservable(scheduler);
    };
    EmptyObservable.dispatch = function (arg) {
        var subscriber = arg.subscriber;
        subscriber.complete();
    };
    EmptyObservable.prototype._subscribe = function (subscriber) {
        var scheduler = this.scheduler;
        if (scheduler) {
            return scheduler.schedule(EmptyObservable.dispatch, 0, { subscriber: subscriber });
        }
        else {
            subscriber.complete();
        }
    };
    return EmptyObservable;
}(Observable_1.Observable));
exports.EmptyObservable = EmptyObservable;
//# sourceMappingURL=EmptyObservable.js.map

/***/ }),
/* 8 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

// typeof any so that it we don't have to cast when comparing a result to the error object
exports.errorObject = { e: {} };
//# sourceMappingURL=errorObject.js.map

/***/ }),
/* 9 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

exports.isArray = Array.isArray || (function (x) { return x && typeof x.length === 'number'; });
//# sourceMappingURL=isArray.js.map

/***/ }),
/* 10 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

function isScheduler(value) {
    return value && typeof value.schedule === 'function';
}
exports.isScheduler = isScheduler;
//# sourceMappingURL=isScheduler.js.map

/***/ }),
/* 11 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var concat_1 = __webpack_require__(23);
Observable_1.Observable.prototype.concat = concat_1.concat;
//# sourceMappingURL=concat.js.map

/***/ }),
/* 12 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Observable_1 = __webpack_require__(0);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @extends {Ignored}
 * @hide true
 */
var ScalarObservable = (function (_super) {
    __extends(ScalarObservable, _super);
    function ScalarObservable(value, scheduler) {
        _super.call(this);
        this.value = value;
        this.scheduler = scheduler;
        this._isScalar = true;
        if (scheduler) {
            this._isScalar = false;
        }
    }
    ScalarObservable.create = function (value, scheduler) {
        return new ScalarObservable(value, scheduler);
    };
    ScalarObservable.dispatch = function (state) {
        var done = state.done, value = state.value, subscriber = state.subscriber;
        if (done) {
            subscriber.complete();
            return;
        }
        subscriber.next(value);
        if (subscriber.closed) {
            return;
        }
        state.done = true;
        this.schedule(state);
    };
    ScalarObservable.prototype._subscribe = function (subscriber) {
        var value = this.value;
        var scheduler = this.scheduler;
        if (scheduler) {
            return scheduler.schedule(ScalarObservable.dispatch, 0, {
                done: false, value: value, subscriber: subscriber
            });
        }
        else {
            subscriber.next(value);
            if (!subscriber.closed) {
                subscriber.complete();
            }
        }
    };
    return ScalarObservable;
}(Observable_1.Observable));
exports.ScalarObservable = ScalarObservable;
//# sourceMappingURL=ScalarObservable.js.map

/***/ }),
/* 13 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var AsyncAction_1 = __webpack_require__(88);
var AsyncScheduler_1 = __webpack_require__(89);
/**
 *
 * Async Scheduler
 *
 * <span class="informal">Schedule task as if you used setTimeout(task, duration)</span>
 *
 * `async` scheduler schedules tasks asynchronously, by putting them on the JavaScript
 * event loop queue. It is best used to delay tasks in time or to schedule tasks repeating
 * in intervals.
 *
 * If you just want to "defer" task, that is to perform it right after currently
 * executing synchronous code ends (commonly achieved by `setTimeout(deferredTask, 0)`),
 * better choice will be the {@link asap} scheduler.
 *
 * @example <caption>Use async scheduler to delay task</caption>
 * const task = () => console.log('it works!');
 *
 * Rx.Scheduler.async.schedule(task, 2000);
 *
 * // After 2 seconds logs:
 * // "it works!"
 *
 *
 * @example <caption>Use async scheduler to repeat task in intervals</caption>
 * function task(state) {
 *   console.log(state);
 *   this.schedule(state + 1, 1000); // `this` references currently executing Action,
 *                                   // which we reschedule with new state and delay
 * }
 *
 * Rx.Scheduler.async.schedule(task, 3000, 0);
 *
 * // Logs:
 * // 0 after 3s
 * // 1 after 4s
 * // 2 after 5s
 * // 3 after 6s
 *
 * @static true
 * @name async
 * @owner Scheduler
 */
exports.async = new AsyncScheduler_1.AsyncScheduler(AsyncAction_1.AsyncAction);
//# sourceMappingURL=async.js.map

/***/ }),
/* 14 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var root_1 = __webpack_require__(2);
function symbolIteratorPonyfill(root) {
    var Symbol = root.Symbol;
    if (typeof Symbol === 'function') {
        if (!Symbol.iterator) {
            Symbol.iterator = Symbol('iterator polyfill');
        }
        return Symbol.iterator;
    }
    else {
        // [for Mozilla Gecko 27-35:](https://mzl.la/2ewE1zC)
        var Set_1 = root.Set;
        if (Set_1 && typeof new Set_1()['@@iterator'] === 'function') {
            return '@@iterator';
        }
        var Map_1 = root.Map;
        // required for compatability with es6-shim
        if (Map_1) {
            var keys = Object.getOwnPropertyNames(Map_1.prototype);
            for (var i = 0; i < keys.length; ++i) {
                var key = keys[i];
                // according to spec, Map.prototype[@@iterator] and Map.orototype.entries must be equal.
                if (key !== 'entries' && key !== 'size' && Map_1.prototype[key] === Map_1.prototype['entries']) {
                    return key;
                }
            }
        }
        return '@@iterator';
    }
}
exports.symbolIteratorPonyfill = symbolIteratorPonyfill;
exports.iterator = symbolIteratorPonyfill(root_1.root);
/**
 * @deprecated use iterator instead
 */
exports.$$iterator = exports.iterator;
//# sourceMappingURL=iterator.js.map

/***/ }),
/* 15 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var root_1 = __webpack_require__(2);
function getSymbolObservable(context) {
    var $$observable;
    var Symbol = context.Symbol;
    if (typeof Symbol === 'function') {
        if (Symbol.observable) {
            $$observable = Symbol.observable;
        }
        else {
            $$observable = Symbol('observable');
            Symbol.observable = $$observable;
        }
    }
    else {
        $$observable = '@@observable';
    }
    return $$observable;
}
exports.getSymbolObservable = getSymbolObservable;
exports.observable = getSymbolObservable(root_1.root);
/**
 * @deprecated use observable instead
 */
exports.$$observable = exports.observable;
//# sourceMappingURL=observable.js.map

/***/ }),
/* 16 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var root_1 = __webpack_require__(2);
var Symbol = root_1.root.Symbol;
exports.rxSubscriber = (typeof Symbol === 'function' && typeof Symbol.for === 'function') ?
    Symbol.for('rxSubscriber') : '@@rxSubscriber';
/**
 * @deprecated use rxSubscriber instead
 */
exports.$$rxSubscriber = exports.rxSubscriber;
//# sourceMappingURL=rxSubscriber.js.map

/***/ }),
/* 17 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

function isFunction(x) {
    return typeof x === 'function';
}
exports.isFunction = isFunction;
//# sourceMappingURL=isFunction.js.map

/***/ }),
/* 18 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var errorObject_1 = __webpack_require__(8);
var tryCatchTarget;
function tryCatcher() {
    try {
        return tryCatchTarget.apply(this, arguments);
    }
    catch (e) {
        errorObject_1.errorObject.e = e;
        return errorObject_1.errorObject;
    }
}
function tryCatch(fn) {
    tryCatchTarget = fn;
    return tryCatcher;
}
exports.tryCatch = tryCatch;
;
//# sourceMappingURL=tryCatch.js.map

/***/ }),
/* 19 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var isArray_1 = __webpack_require__(9);
var isArrayLike_1 = __webpack_require__(26);
var isPromise_1 = __webpack_require__(28);
var PromiseObservable_1 = __webpack_require__(22);
var IteratorObservable_1 = __webpack_require__(61);
var ArrayObservable_1 = __webpack_require__(5);
var ArrayLikeObservable_1 = __webpack_require__(58);
var iterator_1 = __webpack_require__(14);
var Observable_1 = __webpack_require__(0);
var observeOn_1 = __webpack_require__(79);
var observable_1 = __webpack_require__(15);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @extends {Ignored}
 * @hide true
 */
var FromObservable = (function (_super) {
    __extends(FromObservable, _super);
    function FromObservable(ish, scheduler) {
        _super.call(this, null);
        this.ish = ish;
        this.scheduler = scheduler;
    }
    /**
     * Creates an Observable from an Array, an array-like object, a Promise, an
     * iterable object, or an Observable-like object.
     *
     * <span class="informal">Converts almost anything to an Observable.</span>
     *
     * <img src="./img/from.png" width="100%">
     *
     * Convert various other objects and data types into Observables. `from`
     * converts a Promise or an array-like or an
     * [iterable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols#iterable)
     * object into an Observable that emits the items in that promise or array or
     * iterable. A String, in this context, is treated as an array of characters.
     * Observable-like objects (contains a function named with the ES2015 Symbol
     * for Observable) can also be converted through this operator.
     *
     * @example <caption>Converts an array to an Observable</caption>
     * var array = [10, 20, 30];
     * var result = Rx.Observable.from(array);
     * result.subscribe(x => console.log(x));
     *
     * // Results in the following:
     * // 10 20 30
     *
     * @example <caption>Convert an infinite iterable (from a generator) to an Observable</caption>
     * function* generateDoubles(seed) {
     *   var i = seed;
     *   while (true) {
     *     yield i;
     *     i = 2 * i; // double it
     *   }
     * }
     *
     * var iterator = generateDoubles(3);
     * var result = Rx.Observable.from(iterator).take(10);
     * result.subscribe(x => console.log(x));
     *
     * // Results in the following:
     * // 3 6 12 24 48 96 192 384 768 1536
     *
     * @see {@link create}
     * @see {@link fromEvent}
     * @see {@link fromEventPattern}
     * @see {@link fromPromise}
     *
     * @param {ObservableInput<T>} ish A subscribable object, a Promise, an
     * Observable-like, an Array, an iterable or an array-like object to be
     * converted.
     * @param {Scheduler} [scheduler] The scheduler on which to schedule the
     * emissions of values.
     * @return {Observable<T>} The Observable whose values are originally from the
     * input object that was converted.
     * @static true
     * @name from
     * @owner Observable
     */
    FromObservable.create = function (ish, scheduler) {
        if (ish != null) {
            if (typeof ish[observable_1.observable] === 'function') {
                if (ish instanceof Observable_1.Observable && !scheduler) {
                    return ish;
                }
                return new FromObservable(ish, scheduler);
            }
            else if (isArray_1.isArray(ish)) {
                return new ArrayObservable_1.ArrayObservable(ish, scheduler);
            }
            else if (isPromise_1.isPromise(ish)) {
                return new PromiseObservable_1.PromiseObservable(ish, scheduler);
            }
            else if (typeof ish[iterator_1.iterator] === 'function' || typeof ish === 'string') {
                return new IteratorObservable_1.IteratorObservable(ish, scheduler);
            }
            else if (isArrayLike_1.isArrayLike(ish)) {
                return new ArrayLikeObservable_1.ArrayLikeObservable(ish, scheduler);
            }
        }
        throw new TypeError((ish !== null && typeof ish || ish) + ' is not observable');
    };
    FromObservable.prototype._subscribe = function (subscriber) {
        var ish = this.ish;
        var scheduler = this.scheduler;
        if (scheduler == null) {
            return ish[observable_1.observable]().subscribe(subscriber);
        }
        else {
            return ish[observable_1.observable]().subscribe(new observeOn_1.ObserveOnSubscriber(subscriber, scheduler, 0));
        }
    };
    return FromObservable;
}(Observable_1.Observable));
exports.FromObservable = FromObservable;
//# sourceMappingURL=FromObservable.js.map

/***/ }),
/* 20 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
/**
 * Represents a push-based event or value that an {@link Observable} can emit.
 * This class is particularly useful for operators that manage notifications,
 * like {@link materialize}, {@link dematerialize}, {@link observeOn}, and
 * others. Besides wrapping the actual delivered value, it also annotates it
 * with metadata of, for instance, what type of push message it is (`next`,
 * `error`, or `complete`).
 *
 * @see {@link materialize}
 * @see {@link dematerialize}
 * @see {@link observeOn}
 *
 * @class Notification<T>
 */
var Notification = (function () {
    function Notification(kind, value, error) {
        this.kind = kind;
        this.value = value;
        this.error = error;
        this.hasValue = kind === 'N';
    }
    /**
     * Delivers to the given `observer` the value wrapped by this Notification.
     * @param {Observer} observer
     * @return
     */
    Notification.prototype.observe = function (observer) {
        switch (this.kind) {
            case 'N':
                return observer.next && observer.next(this.value);
            case 'E':
                return observer.error && observer.error(this.error);
            case 'C':
                return observer.complete && observer.complete();
        }
    };
    /**
     * Given some {@link Observer} callbacks, deliver the value represented by the
     * current Notification to the correctly corresponding callback.
     * @param {function(value: T): void} next An Observer `next` callback.
     * @param {function(err: any): void} [error] An Observer `error` callback.
     * @param {function(): void} [complete] An Observer `complete` callback.
     * @return {any}
     */
    Notification.prototype.do = function (next, error, complete) {
        var kind = this.kind;
        switch (kind) {
            case 'N':
                return next && next(this.value);
            case 'E':
                return error && error(this.error);
            case 'C':
                return complete && complete();
        }
    };
    /**
     * Takes an Observer or its individual callback functions, and calls `observe`
     * or `do` methods accordingly.
     * @param {Observer|function(value: T): void} nextOrObserver An Observer or
     * the `next` callback.
     * @param {function(err: any): void} [error] An Observer `error` callback.
     * @param {function(): void} [complete] An Observer `complete` callback.
     * @return {any}
     */
    Notification.prototype.accept = function (nextOrObserver, error, complete) {
        if (nextOrObserver && typeof nextOrObserver.next === 'function') {
            return this.observe(nextOrObserver);
        }
        else {
            return this.do(nextOrObserver, error, complete);
        }
    };
    /**
     * Returns a simple Observable that just delivers the notification represented
     * by this Notification instance.
     * @return {any}
     */
    Notification.prototype.toObservable = function () {
        var kind = this.kind;
        switch (kind) {
            case 'N':
                return Observable_1.Observable.of(this.value);
            case 'E':
                return Observable_1.Observable.throw(this.error);
            case 'C':
                return Observable_1.Observable.empty();
        }
        throw new Error('unexpected notification kind value');
    };
    /**
     * A shortcut to create a Notification instance of the type `next` from a
     * given value.
     * @param {T} value The `next` value.
     * @return {Notification<T>} The "next" Notification representing the
     * argument.
     */
    Notification.createNext = function (value) {
        if (typeof value !== 'undefined') {
            return new Notification('N', value);
        }
        return this.undefinedValueNotification;
    };
    /**
     * A shortcut to create a Notification instance of the type `error` from a
     * given error.
     * @param {any} [err] The `error` error.
     * @return {Notification<T>} The "error" Notification representing the
     * argument.
     */
    Notification.createError = function (err) {
        return new Notification('E', undefined, err);
    };
    /**
     * A shortcut to create a Notification instance of the type `complete`.
     * @return {Notification<any>} The valueless "complete" Notification.
     */
    Notification.createComplete = function () {
        return this.completeNotification;
    };
    Notification.completeNotification = new Notification('C');
    Notification.undefinedValueNotification = new Notification('N', undefined);
    return Notification;
}());
exports.Notification = Notification;
//# sourceMappingURL=Notification.js.map

/***/ }),
/* 21 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

exports.empty = {
    closed: true,
    next: function (value) { },
    error: function (err) { throw err; },
    complete: function () { }
};
//# sourceMappingURL=Observer.js.map

/***/ }),
/* 22 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var root_1 = __webpack_require__(2);
var Observable_1 = __webpack_require__(0);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @extends {Ignored}
 * @hide true
 */
var PromiseObservable = (function (_super) {
    __extends(PromiseObservable, _super);
    function PromiseObservable(promise, scheduler) {
        _super.call(this);
        this.promise = promise;
        this.scheduler = scheduler;
    }
    /**
     * Converts a Promise to an Observable.
     *
     * <span class="informal">Returns an Observable that just emits the Promise's
     * resolved value, then completes.</span>
     *
     * Converts an ES2015 Promise or a Promises/A+ spec compliant Promise to an
     * Observable. If the Promise resolves with a value, the output Observable
     * emits that resolved value as a `next`, and then completes. If the Promise
     * is rejected, then the output Observable emits the corresponding Error.
     *
     * @example <caption>Convert the Promise returned by Fetch to an Observable</caption>
     * var result = Rx.Observable.fromPromise(fetch('http://myserver.com/'));
     * result.subscribe(x => console.log(x), e => console.error(e));
     *
     * @see {@link bindCallback}
     * @see {@link from}
     *
     * @param {Promise<T>} promise The promise to be converted.
     * @param {Scheduler} [scheduler] An optional IScheduler to use for scheduling
     * the delivery of the resolved value (or the rejection).
     * @return {Observable<T>} An Observable which wraps the Promise.
     * @static true
     * @name fromPromise
     * @owner Observable
     */
    PromiseObservable.create = function (promise, scheduler) {
        return new PromiseObservable(promise, scheduler);
    };
    PromiseObservable.prototype._subscribe = function (subscriber) {
        var _this = this;
        var promise = this.promise;
        var scheduler = this.scheduler;
        if (scheduler == null) {
            if (this._isScalar) {
                if (!subscriber.closed) {
                    subscriber.next(this.value);
                    subscriber.complete();
                }
            }
            else {
                promise.then(function (value) {
                    _this.value = value;
                    _this._isScalar = true;
                    if (!subscriber.closed) {
                        subscriber.next(value);
                        subscriber.complete();
                    }
                }, function (err) {
                    if (!subscriber.closed) {
                        subscriber.error(err);
                    }
                })
                    .then(null, function (err) {
                    // escape the promise trap, throw unhandled errors
                    root_1.root.setTimeout(function () { throw err; });
                });
            }
        }
        else {
            if (this._isScalar) {
                if (!subscriber.closed) {
                    return scheduler.schedule(dispatchNext, 0, { value: this.value, subscriber: subscriber });
                }
            }
            else {
                promise.then(function (value) {
                    _this.value = value;
                    _this._isScalar = true;
                    if (!subscriber.closed) {
                        subscriber.add(scheduler.schedule(dispatchNext, 0, { value: value, subscriber: subscriber }));
                    }
                }, function (err) {
                    if (!subscriber.closed) {
                        subscriber.add(scheduler.schedule(dispatchError, 0, { err: err, subscriber: subscriber }));
                    }
                })
                    .then(null, function (err) {
                    // escape the promise trap, throw unhandled errors
                    root_1.root.setTimeout(function () { throw err; });
                });
            }
        }
    };
    return PromiseObservable;
}(Observable_1.Observable));
exports.PromiseObservable = PromiseObservable;
function dispatchNext(arg) {
    var value = arg.value, subscriber = arg.subscriber;
    if (!subscriber.closed) {
        subscriber.next(value);
        subscriber.complete();
    }
}
function dispatchError(arg) {
    var err = arg.err, subscriber = arg.subscriber;
    if (!subscriber.closed) {
        subscriber.error(err);
    }
}
//# sourceMappingURL=PromiseObservable.js.map

/***/ }),
/* 23 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var isScheduler_1 = __webpack_require__(10);
var ArrayObservable_1 = __webpack_require__(5);
var mergeAll_1 = __webpack_require__(24);
/* tslint:enable:max-line-length */
/**
 * Creates an output Observable which sequentially emits all values from every
 * given input Observable after the current Observable.
 *
 * <span class="informal">Concatenates multiple Observables together by
 * sequentially emitting their values, one Observable after the other.</span>
 *
 * <img src="./img/concat.png" width="100%">
 *
 * Joins this Observable with multiple other Observables by subscribing to them
 * one at a time, starting with the source, and merging their results into the
 * output Observable. Will wait for each Observable to complete before moving
 * on to the next.
 *
 * @example <caption>Concatenate a timer counting from 0 to 3 with a synchronous sequence from 1 to 10</caption>
 * var timer = Rx.Observable.interval(1000).take(4);
 * var sequence = Rx.Observable.range(1, 10);
 * var result = timer.concat(sequence);
 * result.subscribe(x => console.log(x));
 *
 * // results in:
 * // 1000ms-> 0 -1000ms-> 1 -1000ms-> 2 -1000ms-> 3 -immediate-> 1 ... 10
 *
 * @example <caption>Concatenate 3 Observables</caption>
 * var timer1 = Rx.Observable.interval(1000).take(10);
 * var timer2 = Rx.Observable.interval(2000).take(6);
 * var timer3 = Rx.Observable.interval(500).take(10);
 * var result = timer1.concat(timer2, timer3);
 * result.subscribe(x => console.log(x));
 *
 * // results in the following:
 * // (Prints to console sequentially)
 * // -1000ms-> 0 -1000ms-> 1 -1000ms-> ... 9
 * // -2000ms-> 0 -2000ms-> 1 -2000ms-> ... 5
 * // -500ms-> 0 -500ms-> 1 -500ms-> ... 9
 *
 * @see {@link concatAll}
 * @see {@link concatMap}
 * @see {@link concatMapTo}
 *
 * @param {ObservableInput} other An input Observable to concatenate after the source
 * Observable. More than one input Observables may be given as argument.
 * @param {Scheduler} [scheduler=null] An optional IScheduler to schedule each
 * Observable subscription on.
 * @return {Observable} All values of each passed Observable merged into a
 * single Observable, in order, in serial fashion.
 * @method concat
 * @owner Observable
 */
function concat() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        observables[_i - 0] = arguments[_i];
    }
    return this.lift.call(concatStatic.apply(void 0, [this].concat(observables)));
}
exports.concat = concat;
/* tslint:enable:max-line-length */
/**
 * Creates an output Observable which sequentially emits all values from given
 * Observable and then moves on to the next.
 *
 * <span class="informal">Concatenates multiple Observables together by
 * sequentially emitting their values, one Observable after the other.</span>
 *
 * <img src="./img/concat.png" width="100%">
 *
 * `concat` joins multiple Observables together, by subscribing to them one at a time and
 * merging their results into the output Observable. You can pass either an array of
 * Observables, or put them directly as arguments. Passing an empty array will result
 * in Observable that completes immediately.
 *
 * `concat` will subscribe to first input Observable and emit all its values, without
 * changing or affecting them in any way. When that Observable completes, it will
 * subscribe to then next Observable passed and, again, emit its values. This will be
 * repeated, until the operator runs out of Observables. When last input Observable completes,
 * `concat` will complete as well. At any given moment only one Observable passed to operator
 * emits values. If you would like to emit values from passed Observables concurrently, check out
 * {@link merge} instead, especially with optional `concurrent` parameter. As a matter of fact,
 * `concat` is an equivalent of `merge` operator with `concurrent` parameter set to `1`.
 *
 * Note that if some input Observable never completes, `concat` will also never complete
 * and Observables following the one that did not complete will never be subscribed. On the other
 * hand, if some Observable simply completes immediately after it is subscribed, it will be
 * invisible for `concat`, which will just move on to the next Observable.
 *
 * If any Observable in chain errors, instead of passing control to the next Observable,
 * `concat` will error immediately as well. Observables that would be subscribed after
 * the one that emitted error, never will.
 *
 * If you pass to `concat` the same Observable many times, its stream of values
 * will be "replayed" on every subscription, which means you can repeat given Observable
 * as many times as you like. If passing the same Observable to `concat` 1000 times becomes tedious,
 * you can always use {@link repeat}.
 *
 * @example <caption>Concatenate a timer counting from 0 to 3 with a synchronous sequence from 1 to 10</caption>
 * var timer = Rx.Observable.interval(1000).take(4);
 * var sequence = Rx.Observable.range(1, 10);
 * var result = Rx.Observable.concat(timer, sequence);
 * result.subscribe(x => console.log(x));
 *
 * // results in:
 * // 0 -1000ms-> 1 -1000ms-> 2 -1000ms-> 3 -immediate-> 1 ... 10
 *
 *
 * @example <caption>Concatenate an array of 3 Observables</caption>
 * var timer1 = Rx.Observable.interval(1000).take(10);
 * var timer2 = Rx.Observable.interval(2000).take(6);
 * var timer3 = Rx.Observable.interval(500).take(10);
 * var result = Rx.Observable.concat([timer1, timer2, timer3]); // note that array is passed
 * result.subscribe(x => console.log(x));
 *
 * // results in the following:
 * // (Prints to console sequentially)
 * // -1000ms-> 0 -1000ms-> 1 -1000ms-> ... 9
 * // -2000ms-> 0 -2000ms-> 1 -2000ms-> ... 5
 * // -500ms-> 0 -500ms-> 1 -500ms-> ... 9
 *
 *
 * @example <caption>Concatenate the same Observable to repeat it</caption>
 * const timer = Rx.Observable.interval(1000).take(2);
 *
 * Rx.Observable.concat(timer, timer) // concating the same Observable!
 * .subscribe(
 *   value => console.log(value),
 *   err => {},
 *   () => console.log('...and it is done!')
 * );
 *
 * // Logs:
 * // 0 after 1s
 * // 1 after 2s
 * // 0 after 3s
 * // 1 after 4s
 * // "...and it is done!" also after 4s
 *
 * @see {@link concatAll}
 * @see {@link concatMap}
 * @see {@link concatMapTo}
 *
 * @param {ObservableInput} input1 An input Observable to concatenate with others.
 * @param {ObservableInput} input2 An input Observable to concatenate with others.
 * More than one input Observables may be given as argument.
 * @param {Scheduler} [scheduler=null] An optional IScheduler to schedule each
 * Observable subscription on.
 * @return {Observable} All values of each passed Observable merged into a
 * single Observable, in order, in serial fashion.
 * @static true
 * @name concat
 * @owner Observable
 */
function concatStatic() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        observables[_i - 0] = arguments[_i];
    }
    var scheduler = null;
    var args = observables;
    if (isScheduler_1.isScheduler(args[observables.length - 1])) {
        scheduler = args.pop();
    }
    if (scheduler === null && observables.length === 1 && observables[0] instanceof Observable_1.Observable) {
        return observables[0];
    }
    return new ArrayObservable_1.ArrayObservable(observables, scheduler).lift(new mergeAll_1.MergeAllOperator(1));
}
exports.concatStatic = concatStatic;
//# sourceMappingURL=concat.js.map

/***/ }),
/* 24 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var OuterSubscriber_1 = __webpack_require__(3);
var subscribeToResult_1 = __webpack_require__(6);
/**
 * Converts a higher-order Observable into a first-order Observable which
 * concurrently delivers all values that are emitted on the inner Observables.
 *
 * <span class="informal">Flattens an Observable-of-Observables.</span>
 *
 * <img src="./img/mergeAll.png" width="100%">
 *
 * `mergeAll` subscribes to an Observable that emits Observables, also known as
 * a higher-order Observable. Each time it observes one of these emitted inner
 * Observables, it subscribes to that and delivers all the values from the
 * inner Observable on the output Observable. The output Observable only
 * completes once all inner Observables have completed. Any error delivered by
 * a inner Observable will be immediately emitted on the output Observable.
 *
 * @example <caption>Spawn a new interval Observable for each click event, and blend their outputs as one Observable</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var higherOrder = clicks.map((ev) => Rx.Observable.interval(1000));
 * var firstOrder = higherOrder.mergeAll();
 * firstOrder.subscribe(x => console.log(x));
 *
 * @example <caption>Count from 0 to 9 every second for each click, but only allow 2 concurrent timers</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var higherOrder = clicks.map((ev) => Rx.Observable.interval(1000).take(10));
 * var firstOrder = higherOrder.mergeAll(2);
 * firstOrder.subscribe(x => console.log(x));
 *
 * @see {@link combineAll}
 * @see {@link concatAll}
 * @see {@link exhaust}
 * @see {@link merge}
 * @see {@link mergeMap}
 * @see {@link mergeMapTo}
 * @see {@link mergeScan}
 * @see {@link switch}
 * @see {@link zipAll}
 *
 * @param {number} [concurrent=Number.POSITIVE_INFINITY] Maximum number of inner
 * Observables being subscribed to concurrently.
 * @return {Observable} An Observable that emits values coming from all the
 * inner Observables emitted by the source Observable.
 * @method mergeAll
 * @owner Observable
 */
function mergeAll(concurrent) {
    if (concurrent === void 0) { concurrent = Number.POSITIVE_INFINITY; }
    return this.lift(new MergeAllOperator(concurrent));
}
exports.mergeAll = mergeAll;
var MergeAllOperator = (function () {
    function MergeAllOperator(concurrent) {
        this.concurrent = concurrent;
    }
    MergeAllOperator.prototype.call = function (observer, source) {
        return source.subscribe(new MergeAllSubscriber(observer, this.concurrent));
    };
    return MergeAllOperator;
}());
exports.MergeAllOperator = MergeAllOperator;
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var MergeAllSubscriber = (function (_super) {
    __extends(MergeAllSubscriber, _super);
    function MergeAllSubscriber(destination, concurrent) {
        _super.call(this, destination);
        this.concurrent = concurrent;
        this.hasCompleted = false;
        this.buffer = [];
        this.active = 0;
    }
    MergeAllSubscriber.prototype._next = function (observable) {
        if (this.active < this.concurrent) {
            this.active++;
            this.add(subscribeToResult_1.subscribeToResult(this, observable));
        }
        else {
            this.buffer.push(observable);
        }
    };
    MergeAllSubscriber.prototype._complete = function () {
        this.hasCompleted = true;
        if (this.active === 0 && this.buffer.length === 0) {
            this.destination.complete();
        }
    };
    MergeAllSubscriber.prototype.notifyComplete = function (innerSub) {
        var buffer = this.buffer;
        this.remove(innerSub);
        this.active--;
        if (buffer.length > 0) {
            this._next(buffer.shift());
        }
        else if (this.active === 0 && this.hasCompleted) {
            this.destination.complete();
        }
    };
    return MergeAllSubscriber;
}(OuterSubscriber_1.OuterSubscriber));
exports.MergeAllSubscriber = MergeAllSubscriber;
//# sourceMappingURL=mergeAll.js.map

/***/ }),
/* 25 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var subscribeToResult_1 = __webpack_require__(6);
var OuterSubscriber_1 = __webpack_require__(3);
/* tslint:enable:max-line-length */
/**
 * Projects each source value to an Observable which is merged in the output
 * Observable.
 *
 * <span class="informal">Maps each value to an Observable, then flattens all of
 * these inner Observables using {@link mergeAll}.</span>
 *
 * <img src="./img/mergeMap.png" width="100%">
 *
 * Returns an Observable that emits items based on applying a function that you
 * supply to each item emitted by the source Observable, where that function
 * returns an Observable, and then merging those resulting Observables and
 * emitting the results of this merger.
 *
 * @example <caption>Map and flatten each letter to an Observable ticking every 1 second</caption>
 * var letters = Rx.Observable.of('a', 'b', 'c');
 * var result = letters.mergeMap(x =>
 *   Rx.Observable.interval(1000).map(i => x+i)
 * );
 * result.subscribe(x => console.log(x));
 *
 * // Results in the following:
 * // a0
 * // b0
 * // c0
 * // a1
 * // b1
 * // c1
 * // continues to list a,b,c with respective ascending integers
 *
 * @see {@link concatMap}
 * @see {@link exhaustMap}
 * @see {@link merge}
 * @see {@link mergeAll}
 * @see {@link mergeMapTo}
 * @see {@link mergeScan}
 * @see {@link switchMap}
 *
 * @param {function(value: T, ?index: number): ObservableInput} project A function
 * that, when applied to an item emitted by the source Observable, returns an
 * Observable.
 * @param {function(outerValue: T, innerValue: I, outerIndex: number, innerIndex: number): any} [resultSelector]
 * A function to produce the value on the output Observable based on the values
 * and the indices of the source (outer) emission and the inner Observable
 * emission. The arguments passed to this function are:
 * - `outerValue`: the value that came from the source
 * - `innerValue`: the value that came from the projected Observable
 * - `outerIndex`: the "index" of the value that came from the source
 * - `innerIndex`: the "index" of the value from the projected Observable
 * @param {number} [concurrent=Number.POSITIVE_INFINITY] Maximum number of input
 * Observables being subscribed to concurrently.
 * @return {Observable} An Observable that emits the result of applying the
 * projection function (and the optional `resultSelector`) to each item emitted
 * by the source Observable and merging the results of the Observables obtained
 * from this transformation.
 * @method mergeMap
 * @owner Observable
 */
function mergeMap(project, resultSelector, concurrent) {
    if (concurrent === void 0) { concurrent = Number.POSITIVE_INFINITY; }
    if (typeof resultSelector === 'number') {
        concurrent = resultSelector;
        resultSelector = null;
    }
    return this.lift(new MergeMapOperator(project, resultSelector, concurrent));
}
exports.mergeMap = mergeMap;
var MergeMapOperator = (function () {
    function MergeMapOperator(project, resultSelector, concurrent) {
        if (concurrent === void 0) { concurrent = Number.POSITIVE_INFINITY; }
        this.project = project;
        this.resultSelector = resultSelector;
        this.concurrent = concurrent;
    }
    MergeMapOperator.prototype.call = function (observer, source) {
        return source.subscribe(new MergeMapSubscriber(observer, this.project, this.resultSelector, this.concurrent));
    };
    return MergeMapOperator;
}());
exports.MergeMapOperator = MergeMapOperator;
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var MergeMapSubscriber = (function (_super) {
    __extends(MergeMapSubscriber, _super);
    function MergeMapSubscriber(destination, project, resultSelector, concurrent) {
        if (concurrent === void 0) { concurrent = Number.POSITIVE_INFINITY; }
        _super.call(this, destination);
        this.project = project;
        this.resultSelector = resultSelector;
        this.concurrent = concurrent;
        this.hasCompleted = false;
        this.buffer = [];
        this.active = 0;
        this.index = 0;
    }
    MergeMapSubscriber.prototype._next = function (value) {
        if (this.active < this.concurrent) {
            this._tryNext(value);
        }
        else {
            this.buffer.push(value);
        }
    };
    MergeMapSubscriber.prototype._tryNext = function (value) {
        var result;
        var index = this.index++;
        try {
            result = this.project(value, index);
        }
        catch (err) {
            this.destination.error(err);
            return;
        }
        this.active++;
        this._innerSub(result, value, index);
    };
    MergeMapSubscriber.prototype._innerSub = function (ish, value, index) {
        this.add(subscribeToResult_1.subscribeToResult(this, ish, value, index));
    };
    MergeMapSubscriber.prototype._complete = function () {
        this.hasCompleted = true;
        if (this.active === 0 && this.buffer.length === 0) {
            this.destination.complete();
        }
    };
    MergeMapSubscriber.prototype.notifyNext = function (outerValue, innerValue, outerIndex, innerIndex, innerSub) {
        if (this.resultSelector) {
            this._notifyResultSelector(outerValue, innerValue, outerIndex, innerIndex);
        }
        else {
            this.destination.next(innerValue);
        }
    };
    MergeMapSubscriber.prototype._notifyResultSelector = function (outerValue, innerValue, outerIndex, innerIndex) {
        var result;
        try {
            result = this.resultSelector(outerValue, innerValue, outerIndex, innerIndex);
        }
        catch (err) {
            this.destination.error(err);
            return;
        }
        this.destination.next(result);
    };
    MergeMapSubscriber.prototype.notifyComplete = function (innerSub) {
        var buffer = this.buffer;
        this.remove(innerSub);
        this.active--;
        if (buffer.length > 0) {
            this._next(buffer.shift());
        }
        else if (this.active === 0 && this.hasCompleted) {
            this.destination.complete();
        }
    };
    return MergeMapSubscriber;
}(OuterSubscriber_1.OuterSubscriber));
exports.MergeMapSubscriber = MergeMapSubscriber;
//# sourceMappingURL=mergeMap.js.map

/***/ }),
/* 26 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

exports.isArrayLike = (function (x) { return x && typeof x.length === 'number'; });
//# sourceMappingURL=isArrayLike.js.map

/***/ }),
/* 27 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

function isObject(x) {
    return x != null && typeof x === 'object';
}
exports.isObject = isObject;
//# sourceMappingURL=isObject.js.map

/***/ }),
/* 28 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

function isPromise(value) {
    return value && typeof value.subscribe !== 'function' && typeof value.then === 'function';
}
exports.isPromise = isPromise;
//# sourceMappingURL=isPromise.js.map

/***/ }),
/* 29 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Observable_1 = __webpack_require__(0);
var Subscriber_1 = __webpack_require__(1);
var Subscription_1 = __webpack_require__(4);
var ObjectUnsubscribedError_1 = __webpack_require__(92);
var SubjectSubscription_1 = __webpack_require__(57);
var rxSubscriber_1 = __webpack_require__(16);
/**
 * @class SubjectSubscriber<T>
 */
var SubjectSubscriber = (function (_super) {
    __extends(SubjectSubscriber, _super);
    function SubjectSubscriber(destination) {
        _super.call(this, destination);
        this.destination = destination;
    }
    return SubjectSubscriber;
}(Subscriber_1.Subscriber));
exports.SubjectSubscriber = SubjectSubscriber;
/**
 * @class Subject<T>
 */
var Subject = (function (_super) {
    __extends(Subject, _super);
    function Subject() {
        _super.call(this);
        this.observers = [];
        this.closed = false;
        this.isStopped = false;
        this.hasError = false;
        this.thrownError = null;
    }
    Subject.prototype[rxSubscriber_1.rxSubscriber] = function () {
        return new SubjectSubscriber(this);
    };
    Subject.prototype.lift = function (operator) {
        var subject = new AnonymousSubject(this, this);
        subject.operator = operator;
        return subject;
    };
    Subject.prototype.next = function (value) {
        if (this.closed) {
            throw new ObjectUnsubscribedError_1.ObjectUnsubscribedError();
        }
        if (!this.isStopped) {
            var observers = this.observers;
            var len = observers.length;
            var copy = observers.slice();
            for (var i = 0; i < len; i++) {
                copy[i].next(value);
            }
        }
    };
    Subject.prototype.error = function (err) {
        if (this.closed) {
            throw new ObjectUnsubscribedError_1.ObjectUnsubscribedError();
        }
        this.hasError = true;
        this.thrownError = err;
        this.isStopped = true;
        var observers = this.observers;
        var len = observers.length;
        var copy = observers.slice();
        for (var i = 0; i < len; i++) {
            copy[i].error(err);
        }
        this.observers.length = 0;
    };
    Subject.prototype.complete = function () {
        if (this.closed) {
            throw new ObjectUnsubscribedError_1.ObjectUnsubscribedError();
        }
        this.isStopped = true;
        var observers = this.observers;
        var len = observers.length;
        var copy = observers.slice();
        for (var i = 0; i < len; i++) {
            copy[i].complete();
        }
        this.observers.length = 0;
    };
    Subject.prototype.unsubscribe = function () {
        this.isStopped = true;
        this.closed = true;
        this.observers = null;
    };
    Subject.prototype._trySubscribe = function (subscriber) {
        if (this.closed) {
            throw new ObjectUnsubscribedError_1.ObjectUnsubscribedError();
        }
        else {
            return _super.prototype._trySubscribe.call(this, subscriber);
        }
    };
    Subject.prototype._subscribe = function (subscriber) {
        if (this.closed) {
            throw new ObjectUnsubscribedError_1.ObjectUnsubscribedError();
        }
        else if (this.hasError) {
            subscriber.error(this.thrownError);
            return Subscription_1.Subscription.EMPTY;
        }
        else if (this.isStopped) {
            subscriber.complete();
            return Subscription_1.Subscription.EMPTY;
        }
        else {
            this.observers.push(subscriber);
            return new SubjectSubscription_1.SubjectSubscription(this, subscriber);
        }
    };
    Subject.prototype.asObservable = function () {
        var observable = new Observable_1.Observable();
        observable.source = this;
        return observable;
    };
    Subject.create = function (destination, source) {
        return new AnonymousSubject(destination, source);
    };
    return Subject;
}(Observable_1.Observable));
exports.Subject = Subject;
/**
 * @class AnonymousSubject<T>
 */
var AnonymousSubject = (function (_super) {
    __extends(AnonymousSubject, _super);
    function AnonymousSubject(destination, source) {
        _super.call(this);
        this.destination = destination;
        this.source = source;
    }
    AnonymousSubject.prototype.next = function (value) {
        var destination = this.destination;
        if (destination && destination.next) {
            destination.next(value);
        }
    };
    AnonymousSubject.prototype.error = function (err) {
        var destination = this.destination;
        if (destination && destination.error) {
            this.destination.error(err);
        }
    };
    AnonymousSubject.prototype.complete = function () {
        var destination = this.destination;
        if (destination && destination.complete) {
            this.destination.complete();
        }
    };
    AnonymousSubject.prototype._subscribe = function (subscriber) {
        var source = this.source;
        if (source) {
            return this.source.subscribe(subscriber);
        }
        else {
            return Subscription_1.Subscription.EMPTY;
        }
    };
    return AnonymousSubject;
}(Subject));
exports.AnonymousSubject = AnonymousSubject;
//# sourceMappingURL=Subject.js.map

/***/ }),
/* 30 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var from_1 = __webpack_require__(62);
Observable_1.Observable.from = from_1.from;
//# sourceMappingURL=from.js.map

/***/ }),
/* 31 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var fromEvent_1 = __webpack_require__(63);
Observable_1.Observable.fromEvent = fromEvent_1.fromEvent;
//# sourceMappingURL=fromEvent.js.map

/***/ }),
/* 32 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var fromPromise_1 = __webpack_require__(64);
Observable_1.Observable.fromPromise = fromPromise_1.fromPromise;
//# sourceMappingURL=fromPromise.js.map

/***/ }),
/* 33 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var interval_1 = __webpack_require__(65);
Observable_1.Observable.interval = interval_1.interval;
//# sourceMappingURL=interval.js.map

/***/ }),
/* 34 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var of_1 = __webpack_require__(66);
Observable_1.Observable.of = of_1.of;
//# sourceMappingURL=of.js.map

/***/ }),
/* 35 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var buffer_1 = __webpack_require__(67);
Observable_1.Observable.prototype.buffer = buffer_1.buffer;
//# sourceMappingURL=buffer.js.map

/***/ }),
/* 36 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var catch_1 = __webpack_require__(68);
Observable_1.Observable.prototype.catch = catch_1._catch;
Observable_1.Observable.prototype._catch = catch_1._catch;
//# sourceMappingURL=catch.js.map

/***/ }),
/* 37 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var concatMap_1 = __webpack_require__(69);
Observable_1.Observable.prototype.concatMap = concatMap_1.concatMap;
//# sourceMappingURL=concatMap.js.map

/***/ }),
/* 38 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var debounceTime_1 = __webpack_require__(70);
Observable_1.Observable.prototype.debounceTime = debounceTime_1.debounceTime;
//# sourceMappingURL=debounceTime.js.map

/***/ }),
/* 39 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var delay_1 = __webpack_require__(71);
Observable_1.Observable.prototype.delay = delay_1.delay;
//# sourceMappingURL=delay.js.map

/***/ }),
/* 40 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var distinctUntilChanged_1 = __webpack_require__(72);
Observable_1.Observable.prototype.distinctUntilChanged = distinctUntilChanged_1.distinctUntilChanged;
//# sourceMappingURL=distinctUntilChanged.js.map

/***/ }),
/* 41 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var do_1 = __webpack_require__(73);
Observable_1.Observable.prototype.do = do_1._do;
Observable_1.Observable.prototype._do = do_1._do;
//# sourceMappingURL=do.js.map

/***/ }),
/* 42 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var filter_1 = __webpack_require__(74);
Observable_1.Observable.prototype.filter = filter_1.filter;
//# sourceMappingURL=filter.js.map

/***/ }),
/* 43 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var finally_1 = __webpack_require__(75);
Observable_1.Observable.prototype.finally = finally_1._finally;
Observable_1.Observable.prototype._finally = finally_1._finally;
//# sourceMappingURL=finally.js.map

/***/ }),
/* 44 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var last_1 = __webpack_require__(76);
Observable_1.Observable.prototype.last = last_1.last;
//# sourceMappingURL=last.js.map

/***/ }),
/* 45 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var map_1 = __webpack_require__(77);
Observable_1.Observable.prototype.map = map_1.map;
//# sourceMappingURL=map.js.map

/***/ }),
/* 46 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var merge_1 = __webpack_require__(78);
Observable_1.Observable.prototype.merge = merge_1.merge;
//# sourceMappingURL=merge.js.map

/***/ }),
/* 47 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var mergeMap_1 = __webpack_require__(25);
Observable_1.Observable.prototype.mergeMap = mergeMap_1.mergeMap;
Observable_1.Observable.prototype.flatMap = mergeMap_1.mergeMap;
//# sourceMappingURL=mergeMap.js.map

/***/ }),
/* 48 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var race_1 = __webpack_require__(80);
Observable_1.Observable.prototype.race = race_1.race;
//# sourceMappingURL=race.js.map

/***/ }),
/* 49 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var skip_1 = __webpack_require__(81);
Observable_1.Observable.prototype.skip = skip_1.skip;
//# sourceMappingURL=skip.js.map

/***/ }),
/* 50 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var startWith_1 = __webpack_require__(82);
Observable_1.Observable.prototype.startWith = startWith_1.startWith;
//# sourceMappingURL=startWith.js.map

/***/ }),
/* 51 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var take_1 = __webpack_require__(83);
Observable_1.Observable.prototype.take = take_1.take;
//# sourceMappingURL=take.js.map

/***/ }),
/* 52 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var takeUntil_1 = __webpack_require__(84);
Observable_1.Observable.prototype.takeUntil = takeUntil_1.takeUntil;
//# sourceMappingURL=takeUntil.js.map

/***/ }),
/* 53 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var toArray_1 = __webpack_require__(85);
Observable_1.Observable.prototype.toArray = toArray_1.toArray;
//# sourceMappingURL=toArray.js.map

/***/ }),
/* 54 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var toPromise_1 = __webpack_require__(86);
Observable_1.Observable.prototype.toPromise = toPromise_1.toPromise;
//# sourceMappingURL=toPromise.js.map

/***/ }),
/* 55 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var InnerSubscriber = (function (_super) {
    __extends(InnerSubscriber, _super);
    function InnerSubscriber(parent, outerValue, outerIndex) {
        _super.call(this);
        this.parent = parent;
        this.outerValue = outerValue;
        this.outerIndex = outerIndex;
        this.index = 0;
    }
    InnerSubscriber.prototype._next = function (value) {
        this.parent.notifyNext(this.outerValue, value, this.outerIndex, this.index++, this);
    };
    InnerSubscriber.prototype._error = function (error) {
        this.parent.notifyError(error, this);
        this.unsubscribe();
    };
    InnerSubscriber.prototype._complete = function () {
        this.parent.notifyComplete(this);
        this.unsubscribe();
    };
    return InnerSubscriber;
}(Subscriber_1.Subscriber));
exports.InnerSubscriber = InnerSubscriber;
//# sourceMappingURL=InnerSubscriber.js.map

/***/ }),
/* 56 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

/**
 * An execution context and a data structure to order tasks and schedule their
 * execution. Provides a notion of (potentially virtual) time, through the
 * `now()` getter method.
 *
 * Each unit of work in a Scheduler is called an {@link Action}.
 *
 * ```ts
 * class Scheduler {
 *   now(): number;
 *   schedule(work, delay?, state?): Subscription;
 * }
 * ```
 *
 * @class Scheduler
 */
var Scheduler = (function () {
    function Scheduler(SchedulerAction, now) {
        if (now === void 0) { now = Scheduler.now; }
        this.SchedulerAction = SchedulerAction;
        this.now = now;
    }
    /**
     * Schedules a function, `work`, for execution. May happen at some point in
     * the future, according to the `delay` parameter, if specified. May be passed
     * some context object, `state`, which will be passed to the `work` function.
     *
     * The given arguments will be processed an stored as an Action object in a
     * queue of actions.
     *
     * @param {function(state: ?T): ?Subscription} work A function representing a
     * task, or some unit of work to be executed by the Scheduler.
     * @param {number} [delay] Time to wait before executing the work, where the
     * time unit is implicit and defined by the Scheduler itself.
     * @param {T} [state] Some contextual data that the `work` function uses when
     * called by the Scheduler.
     * @return {Subscription} A subscription in order to be able to unsubscribe
     * the scheduled work.
     */
    Scheduler.prototype.schedule = function (work, delay, state) {
        if (delay === void 0) { delay = 0; }
        return new this.SchedulerAction(this, work).schedule(state, delay);
    };
    Scheduler.now = Date.now ? Date.now : function () { return +new Date(); };
    return Scheduler;
}());
exports.Scheduler = Scheduler;
//# sourceMappingURL=Scheduler.js.map

/***/ }),
/* 57 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscription_1 = __webpack_require__(4);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var SubjectSubscription = (function (_super) {
    __extends(SubjectSubscription, _super);
    function SubjectSubscription(subject, subscriber) {
        _super.call(this);
        this.subject = subject;
        this.subscriber = subscriber;
        this.closed = false;
    }
    SubjectSubscription.prototype.unsubscribe = function () {
        if (this.closed) {
            return;
        }
        this.closed = true;
        var subject = this.subject;
        var observers = subject.observers;
        this.subject = null;
        if (!observers || observers.length === 0 || subject.isStopped || subject.closed) {
            return;
        }
        var subscriberIndex = observers.indexOf(this.subscriber);
        if (subscriberIndex !== -1) {
            observers.splice(subscriberIndex, 1);
        }
    };
    return SubjectSubscription;
}(Subscription_1.Subscription));
exports.SubjectSubscription = SubjectSubscription;
//# sourceMappingURL=SubjectSubscription.js.map

/***/ }),
/* 58 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Observable_1 = __webpack_require__(0);
var ScalarObservable_1 = __webpack_require__(12);
var EmptyObservable_1 = __webpack_require__(7);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @extends {Ignored}
 * @hide true
 */
var ArrayLikeObservable = (function (_super) {
    __extends(ArrayLikeObservable, _super);
    function ArrayLikeObservable(arrayLike, scheduler) {
        _super.call(this);
        this.arrayLike = arrayLike;
        this.scheduler = scheduler;
        if (!scheduler && arrayLike.length === 1) {
            this._isScalar = true;
            this.value = arrayLike[0];
        }
    }
    ArrayLikeObservable.create = function (arrayLike, scheduler) {
        var length = arrayLike.length;
        if (length === 0) {
            return new EmptyObservable_1.EmptyObservable();
        }
        else if (length === 1) {
            return new ScalarObservable_1.ScalarObservable(arrayLike[0], scheduler);
        }
        else {
            return new ArrayLikeObservable(arrayLike, scheduler);
        }
    };
    ArrayLikeObservable.dispatch = function (state) {
        var arrayLike = state.arrayLike, index = state.index, length = state.length, subscriber = state.subscriber;
        if (subscriber.closed) {
            return;
        }
        if (index >= length) {
            subscriber.complete();
            return;
        }
        subscriber.next(arrayLike[index]);
        state.index = index + 1;
        this.schedule(state);
    };
    ArrayLikeObservable.prototype._subscribe = function (subscriber) {
        var index = 0;
        var _a = this, arrayLike = _a.arrayLike, scheduler = _a.scheduler;
        var length = arrayLike.length;
        if (scheduler) {
            return scheduler.schedule(ArrayLikeObservable.dispatch, 0, {
                arrayLike: arrayLike, index: index, length: length, subscriber: subscriber
            });
        }
        else {
            for (var i = 0; i < length && !subscriber.closed; i++) {
                subscriber.next(arrayLike[i]);
            }
            subscriber.complete();
        }
    };
    return ArrayLikeObservable;
}(Observable_1.Observable));
exports.ArrayLikeObservable = ArrayLikeObservable;
//# sourceMappingURL=ArrayLikeObservable.js.map

/***/ }),
/* 59 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Observable_1 = __webpack_require__(0);
var tryCatch_1 = __webpack_require__(18);
var isFunction_1 = __webpack_require__(17);
var errorObject_1 = __webpack_require__(8);
var Subscription_1 = __webpack_require__(4);
var toString = Object.prototype.toString;
function isNodeStyleEventEmitter(sourceObj) {
    return !!sourceObj && typeof sourceObj.addListener === 'function' && typeof sourceObj.removeListener === 'function';
}
function isJQueryStyleEventEmitter(sourceObj) {
    return !!sourceObj && typeof sourceObj.on === 'function' && typeof sourceObj.off === 'function';
}
function isNodeList(sourceObj) {
    return !!sourceObj && toString.call(sourceObj) === '[object NodeList]';
}
function isHTMLCollection(sourceObj) {
    return !!sourceObj && toString.call(sourceObj) === '[object HTMLCollection]';
}
function isEventTarget(sourceObj) {
    return !!sourceObj && typeof sourceObj.addEventListener === 'function' && typeof sourceObj.removeEventListener === 'function';
}
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @extends {Ignored}
 * @hide true
 */
var FromEventObservable = (function (_super) {
    __extends(FromEventObservable, _super);
    function FromEventObservable(sourceObj, eventName, selector, options) {
        _super.call(this);
        this.sourceObj = sourceObj;
        this.eventName = eventName;
        this.selector = selector;
        this.options = options;
    }
    /* tslint:enable:max-line-length */
    /**
     * Creates an Observable that emits events of a specific type coming from the
     * given event target.
     *
     * <span class="informal">Creates an Observable from DOM events, or Node
     * EventEmitter events or others.</span>
     *
     * <img src="./img/fromEvent.png" width="100%">
     *
     * Creates an Observable by attaching an event listener to an "event target",
     * which may be an object with `addEventListener` and `removeEventListener`,
     * a Node.js EventEmitter, a jQuery style EventEmitter, a NodeList from the
     * DOM, or an HTMLCollection from the DOM. The event handler is attached when
     * the output Observable is subscribed, and removed when the Subscription is
     * unsubscribed.
     *
     * @example <caption>Emits clicks happening on the DOM document</caption>
     * var clicks = Rx.Observable.fromEvent(document, 'click');
     * clicks.subscribe(x => console.log(x));
     *
     * // Results in:
     * // MouseEvent object logged to console everytime a click
     * // occurs on the document.
     *
     * @see {@link from}
     * @see {@link fromEventPattern}
     *
     * @param {EventTargetLike} target The DOMElement, event target, Node.js
     * EventEmitter, NodeList or HTMLCollection to attach the event handler to.
     * @param {string} eventName The event name of interest, being emitted by the
     * `target`.
     * @param {EventListenerOptions} [options] Options to pass through to addEventListener
     * @param {SelectorMethodSignature<T>} [selector] An optional function to
     * post-process results. It takes the arguments from the event handler and
     * should return a single value.
     * @return {Observable<T>}
     * @static true
     * @name fromEvent
     * @owner Observable
     */
    FromEventObservable.create = function (target, eventName, options, selector) {
        if (isFunction_1.isFunction(options)) {
            selector = options;
            options = undefined;
        }
        return new FromEventObservable(target, eventName, selector, options);
    };
    FromEventObservable.setupSubscription = function (sourceObj, eventName, handler, subscriber, options) {
        var unsubscribe;
        if (isNodeList(sourceObj) || isHTMLCollection(sourceObj)) {
            for (var i = 0, len = sourceObj.length; i < len; i++) {
                FromEventObservable.setupSubscription(sourceObj[i], eventName, handler, subscriber, options);
            }
        }
        else if (isEventTarget(sourceObj)) {
            var source_1 = sourceObj;
            sourceObj.addEventListener(eventName, handler, options);
            unsubscribe = function () { return source_1.removeEventListener(eventName, handler); };
        }
        else if (isJQueryStyleEventEmitter(sourceObj)) {
            var source_2 = sourceObj;
            sourceObj.on(eventName, handler);
            unsubscribe = function () { return source_2.off(eventName, handler); };
        }
        else if (isNodeStyleEventEmitter(sourceObj)) {
            var source_3 = sourceObj;
            sourceObj.addListener(eventName, handler);
            unsubscribe = function () { return source_3.removeListener(eventName, handler); };
        }
        else {
            throw new TypeError('Invalid event target');
        }
        subscriber.add(new Subscription_1.Subscription(unsubscribe));
    };
    FromEventObservable.prototype._subscribe = function (subscriber) {
        var sourceObj = this.sourceObj;
        var eventName = this.eventName;
        var options = this.options;
        var selector = this.selector;
        var handler = selector ? function () {
            var args = [];
            for (var _i = 0; _i < arguments.length; _i++) {
                args[_i - 0] = arguments[_i];
            }
            var result = tryCatch_1.tryCatch(selector).apply(void 0, args);
            if (result === errorObject_1.errorObject) {
                subscriber.error(errorObject_1.errorObject.e);
            }
            else {
                subscriber.next(result);
            }
        } : function (e) { return subscriber.next(e); };
        FromEventObservable.setupSubscription(sourceObj, eventName, handler, subscriber, options);
    };
    return FromEventObservable;
}(Observable_1.Observable));
exports.FromEventObservable = FromEventObservable;
//# sourceMappingURL=FromEventObservable.js.map

/***/ }),
/* 60 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var isNumeric_1 = __webpack_require__(95);
var Observable_1 = __webpack_require__(0);
var async_1 = __webpack_require__(13);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @extends {Ignored}
 * @hide true
 */
var IntervalObservable = (function (_super) {
    __extends(IntervalObservable, _super);
    function IntervalObservable(period, scheduler) {
        if (period === void 0) { period = 0; }
        if (scheduler === void 0) { scheduler = async_1.async; }
        _super.call(this);
        this.period = period;
        this.scheduler = scheduler;
        if (!isNumeric_1.isNumeric(period) || period < 0) {
            this.period = 0;
        }
        if (!scheduler || typeof scheduler.schedule !== 'function') {
            this.scheduler = async_1.async;
        }
    }
    /**
     * Creates an Observable that emits sequential numbers every specified
     * interval of time, on a specified IScheduler.
     *
     * <span class="informal">Emits incremental numbers periodically in time.
     * </span>
     *
     * <img src="./img/interval.png" width="100%">
     *
     * `interval` returns an Observable that emits an infinite sequence of
     * ascending integers, with a constant interval of time of your choosing
     * between those emissions. The first emission is not sent immediately, but
     * only after the first period has passed. By default, this operator uses the
     * `async` IScheduler to provide a notion of time, but you may pass any
     * IScheduler to it.
     *
     * @example <caption>Emits ascending numbers, one every second (1000ms)</caption>
     * var numbers = Rx.Observable.interval(1000);
     * numbers.subscribe(x => console.log(x));
     *
     * @see {@link timer}
     * @see {@link delay}
     *
     * @param {number} [period=0] The interval size in milliseconds (by default)
     * or the time unit determined by the scheduler's clock.
     * @param {Scheduler} [scheduler=async] The IScheduler to use for scheduling
     * the emission of values, and providing a notion of "time".
     * @return {Observable} An Observable that emits a sequential number each time
     * interval.
     * @static true
     * @name interval
     * @owner Observable
     */
    IntervalObservable.create = function (period, scheduler) {
        if (period === void 0) { period = 0; }
        if (scheduler === void 0) { scheduler = async_1.async; }
        return new IntervalObservable(period, scheduler);
    };
    IntervalObservable.dispatch = function (state) {
        var index = state.index, subscriber = state.subscriber, period = state.period;
        subscriber.next(index);
        if (subscriber.closed) {
            return;
        }
        state.index += 1;
        this.schedule(state, period);
    };
    IntervalObservable.prototype._subscribe = function (subscriber) {
        var index = 0;
        var period = this.period;
        var scheduler = this.scheduler;
        subscriber.add(scheduler.schedule(IntervalObservable.dispatch, period, {
            index: index, subscriber: subscriber, period: period
        }));
    };
    return IntervalObservable;
}(Observable_1.Observable));
exports.IntervalObservable = IntervalObservable;
//# sourceMappingURL=IntervalObservable.js.map

/***/ }),
/* 61 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var root_1 = __webpack_require__(2);
var Observable_1 = __webpack_require__(0);
var iterator_1 = __webpack_require__(14);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @extends {Ignored}
 * @hide true
 */
var IteratorObservable = (function (_super) {
    __extends(IteratorObservable, _super);
    function IteratorObservable(iterator, scheduler) {
        _super.call(this);
        this.scheduler = scheduler;
        if (iterator == null) {
            throw new Error('iterator cannot be null.');
        }
        this.iterator = getIterator(iterator);
    }
    IteratorObservable.create = function (iterator, scheduler) {
        return new IteratorObservable(iterator, scheduler);
    };
    IteratorObservable.dispatch = function (state) {
        var index = state.index, hasError = state.hasError, iterator = state.iterator, subscriber = state.subscriber;
        if (hasError) {
            subscriber.error(state.error);
            return;
        }
        var result = iterator.next();
        if (result.done) {
            subscriber.complete();
            return;
        }
        subscriber.next(result.value);
        state.index = index + 1;
        if (subscriber.closed) {
            if (typeof iterator.return === 'function') {
                iterator.return();
            }
            return;
        }
        this.schedule(state);
    };
    IteratorObservable.prototype._subscribe = function (subscriber) {
        var index = 0;
        var _a = this, iterator = _a.iterator, scheduler = _a.scheduler;
        if (scheduler) {
            return scheduler.schedule(IteratorObservable.dispatch, 0, {
                index: index, iterator: iterator, subscriber: subscriber
            });
        }
        else {
            do {
                var result = iterator.next();
                if (result.done) {
                    subscriber.complete();
                    break;
                }
                else {
                    subscriber.next(result.value);
                }
                if (subscriber.closed) {
                    if (typeof iterator.return === 'function') {
                        iterator.return();
                    }
                    break;
                }
            } while (true);
        }
    };
    return IteratorObservable;
}(Observable_1.Observable));
exports.IteratorObservable = IteratorObservable;
var StringIterator = (function () {
    function StringIterator(str, idx, len) {
        if (idx === void 0) { idx = 0; }
        if (len === void 0) { len = str.length; }
        this.str = str;
        this.idx = idx;
        this.len = len;
    }
    StringIterator.prototype[iterator_1.iterator] = function () { return (this); };
    StringIterator.prototype.next = function () {
        return this.idx < this.len ? {
            done: false,
            value: this.str.charAt(this.idx++)
        } : {
            done: true,
            value: undefined
        };
    };
    return StringIterator;
}());
var ArrayIterator = (function () {
    function ArrayIterator(arr, idx, len) {
        if (idx === void 0) { idx = 0; }
        if (len === void 0) { len = toLength(arr); }
        this.arr = arr;
        this.idx = idx;
        this.len = len;
    }
    ArrayIterator.prototype[iterator_1.iterator] = function () { return this; };
    ArrayIterator.prototype.next = function () {
        return this.idx < this.len ? {
            done: false,
            value: this.arr[this.idx++]
        } : {
            done: true,
            value: undefined
        };
    };
    return ArrayIterator;
}());
function getIterator(obj) {
    var i = obj[iterator_1.iterator];
    if (!i && typeof obj === 'string') {
        return new StringIterator(obj);
    }
    if (!i && obj.length !== undefined) {
        return new ArrayIterator(obj);
    }
    if (!i) {
        throw new TypeError('object is not iterable');
    }
    return obj[iterator_1.iterator]();
}
var maxSafeInteger = Math.pow(2, 53) - 1;
function toLength(o) {
    var len = +o.length;
    if (isNaN(len)) {
        return 0;
    }
    if (len === 0 || !numberIsFinite(len)) {
        return len;
    }
    len = sign(len) * Math.floor(Math.abs(len));
    if (len <= 0) {
        return 0;
    }
    if (len > maxSafeInteger) {
        return maxSafeInteger;
    }
    return len;
}
function numberIsFinite(value) {
    return typeof value === 'number' && root_1.root.isFinite(value);
}
function sign(value) {
    var valueAsNumber = +value;
    if (valueAsNumber === 0) {
        return valueAsNumber;
    }
    if (isNaN(valueAsNumber)) {
        return valueAsNumber;
    }
    return valueAsNumber < 0 ? -1 : 1;
}
//# sourceMappingURL=IteratorObservable.js.map

/***/ }),
/* 62 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var FromObservable_1 = __webpack_require__(19);
exports.from = FromObservable_1.FromObservable.create;
//# sourceMappingURL=from.js.map

/***/ }),
/* 63 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var FromEventObservable_1 = __webpack_require__(59);
exports.fromEvent = FromEventObservable_1.FromEventObservable.create;
//# sourceMappingURL=fromEvent.js.map

/***/ }),
/* 64 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var PromiseObservable_1 = __webpack_require__(22);
exports.fromPromise = PromiseObservable_1.PromiseObservable.create;
//# sourceMappingURL=fromPromise.js.map

/***/ }),
/* 65 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var IntervalObservable_1 = __webpack_require__(60);
exports.interval = IntervalObservable_1.IntervalObservable.create;
//# sourceMappingURL=interval.js.map

/***/ }),
/* 66 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var ArrayObservable_1 = __webpack_require__(5);
exports.of = ArrayObservable_1.ArrayObservable.of;
//# sourceMappingURL=of.js.map

/***/ }),
/* 67 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var OuterSubscriber_1 = __webpack_require__(3);
var subscribeToResult_1 = __webpack_require__(6);
/**
 * Buffers the source Observable values until `closingNotifier` emits.
 *
 * <span class="informal">Collects values from the past as an array, and emits
 * that array only when another Observable emits.</span>
 *
 * <img src="./img/buffer.png" width="100%">
 *
 * Buffers the incoming Observable values until the given `closingNotifier`
 * Observable emits a value, at which point it emits the buffer on the output
 * Observable and starts a new buffer internally, awaiting the next time
 * `closingNotifier` emits.
 *
 * @example <caption>On every click, emit array of most recent interval events</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var interval = Rx.Observable.interval(1000);
 * var buffered = interval.buffer(clicks);
 * buffered.subscribe(x => console.log(x));
 *
 * @see {@link bufferCount}
 * @see {@link bufferTime}
 * @see {@link bufferToggle}
 * @see {@link bufferWhen}
 * @see {@link window}
 *
 * @param {Observable<any>} closingNotifier An Observable that signals the
 * buffer to be emitted on the output Observable.
 * @return {Observable<T[]>} An Observable of buffers, which are arrays of
 * values.
 * @method buffer
 * @owner Observable
 */
function buffer(closingNotifier) {
    return this.lift(new BufferOperator(closingNotifier));
}
exports.buffer = buffer;
var BufferOperator = (function () {
    function BufferOperator(closingNotifier) {
        this.closingNotifier = closingNotifier;
    }
    BufferOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new BufferSubscriber(subscriber, this.closingNotifier));
    };
    return BufferOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var BufferSubscriber = (function (_super) {
    __extends(BufferSubscriber, _super);
    function BufferSubscriber(destination, closingNotifier) {
        _super.call(this, destination);
        this.buffer = [];
        this.add(subscribeToResult_1.subscribeToResult(this, closingNotifier));
    }
    BufferSubscriber.prototype._next = function (value) {
        this.buffer.push(value);
    };
    BufferSubscriber.prototype.notifyNext = function (outerValue, innerValue, outerIndex, innerIndex, innerSub) {
        var buffer = this.buffer;
        this.buffer = [];
        this.destination.next(buffer);
    };
    return BufferSubscriber;
}(OuterSubscriber_1.OuterSubscriber));
//# sourceMappingURL=buffer.js.map

/***/ }),
/* 68 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var OuterSubscriber_1 = __webpack_require__(3);
var subscribeToResult_1 = __webpack_require__(6);
/**
 * Catches errors on the observable to be handled by returning a new observable or throwing an error.
 *
 * <img src="./img/catch.png" width="100%">
 *
 * @example <caption>Continues with a different Observable when there's an error</caption>
 *
 * Observable.of(1, 2, 3, 4, 5)
 *   .map(n => {
 * 	   if (n == 4) {
 * 	     throw 'four!';
 *     }
 *	   return n;
 *   })
 *   .catch(err => Observable.of('I', 'II', 'III', 'IV', 'V'))
 *   .subscribe(x => console.log(x));
 *   // 1, 2, 3, I, II, III, IV, V
 *
 * @example <caption>Retries the caught source Observable again in case of error, similar to retry() operator</caption>
 *
 * Observable.of(1, 2, 3, 4, 5)
 *   .map(n => {
 * 	   if (n === 4) {
 * 	     throw 'four!';
 *     }
 * 	   return n;
 *   })
 *   .catch((err, caught) => caught)
 *   .take(30)
 *   .subscribe(x => console.log(x));
 *   // 1, 2, 3, 1, 2, 3, ...
 *
 * @example <caption>Throws a new error when the source Observable throws an error</caption>
 *
 * Observable.of(1, 2, 3, 4, 5)
 *   .map(n => {
 *     if (n == 4) {
 *       throw 'four!';
 *     }
 *     return n;
 *   })
 *   .catch(err => {
 *     throw 'error in source. Details: ' + err;
 *   })
 *   .subscribe(
 *     x => console.log(x),
 *     err => console.log(err)
 *   );
 *   // 1, 2, 3, error in source. Details: four!
 *
 * @param {function} selector a function that takes as arguments `err`, which is the error, and `caught`, which
 *  is the source observable, in case you'd like to "retry" that observable by returning it again. Whatever observable
 *  is returned by the `selector` will be used to continue the observable chain.
 * @return {Observable} An observable that originates from either the source or the observable returned by the
 *  catch `selector` function.
 * @method catch
 * @name catch
 * @owner Observable
 */
function _catch(selector) {
    var operator = new CatchOperator(selector);
    var caught = this.lift(operator);
    return (operator.caught = caught);
}
exports._catch = _catch;
var CatchOperator = (function () {
    function CatchOperator(selector) {
        this.selector = selector;
    }
    CatchOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new CatchSubscriber(subscriber, this.selector, this.caught));
    };
    return CatchOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var CatchSubscriber = (function (_super) {
    __extends(CatchSubscriber, _super);
    function CatchSubscriber(destination, selector, caught) {
        _super.call(this, destination);
        this.selector = selector;
        this.caught = caught;
    }
    // NOTE: overriding `error` instead of `_error` because we don't want
    // to have this flag this subscriber as `isStopped`. We can mimic the
    // behavior of the RetrySubscriber (from the `retry` operator), where
    // we unsubscribe from our source chain, reset our Subscriber flags,
    // then subscribe to the selector result.
    CatchSubscriber.prototype.error = function (err) {
        if (!this.isStopped) {
            var result = void 0;
            try {
                result = this.selector(err, this.caught);
            }
            catch (err2) {
                _super.prototype.error.call(this, err2);
                return;
            }
            this._unsubscribeAndRecycle();
            this.add(subscribeToResult_1.subscribeToResult(this, result));
        }
    };
    return CatchSubscriber;
}(OuterSubscriber_1.OuterSubscriber));
//# sourceMappingURL=catch.js.map

/***/ }),
/* 69 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var mergeMap_1 = __webpack_require__(25);
/* tslint:enable:max-line-length */
/**
 * Projects each source value to an Observable which is merged in the output
 * Observable, in a serialized fashion waiting for each one to complete before
 * merging the next.
 *
 * <span class="informal">Maps each value to an Observable, then flattens all of
 * these inner Observables using {@link concatAll}.</span>
 *
 * <img src="./img/concatMap.png" width="100%">
 *
 * Returns an Observable that emits items based on applying a function that you
 * supply to each item emitted by the source Observable, where that function
 * returns an (so-called "inner") Observable. Each new inner Observable is
 * concatenated with the previous inner Observable.
 *
 * __Warning:__ if source values arrive endlessly and faster than their
 * corresponding inner Observables can complete, it will result in memory issues
 * as inner Observables amass in an unbounded buffer waiting for their turn to
 * be subscribed to.
 *
 * Note: `concatMap` is equivalent to `mergeMap` with concurrency parameter set
 * to `1`.
 *
 * @example <caption>For each click event, tick every second from 0 to 3, with no concurrency</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var result = clicks.concatMap(ev => Rx.Observable.interval(1000).take(4));
 * result.subscribe(x => console.log(x));
 *
 * // Results in the following:
 * // (results are not concurrent)
 * // For every click on the "document" it will emit values 0 to 3 spaced
 * // on a 1000ms interval
 * // one click = 1000ms-> 0 -1000ms-> 1 -1000ms-> 2 -1000ms-> 3
 *
 * @see {@link concat}
 * @see {@link concatAll}
 * @see {@link concatMapTo}
 * @see {@link exhaustMap}
 * @see {@link mergeMap}
 * @see {@link switchMap}
 *
 * @param {function(value: T, ?index: number): ObservableInput} project A function
 * that, when applied to an item emitted by the source Observable, returns an
 * Observable.
 * @param {function(outerValue: T, innerValue: I, outerIndex: number, innerIndex: number): any} [resultSelector]
 * A function to produce the value on the output Observable based on the values
 * and the indices of the source (outer) emission and the inner Observable
 * emission. The arguments passed to this function are:
 * - `outerValue`: the value that came from the source
 * - `innerValue`: the value that came from the projected Observable
 * - `outerIndex`: the "index" of the value that came from the source
 * - `innerIndex`: the "index" of the value from the projected Observable
 * @return {Observable} An observable of values merged from the projected
 * Observables as they were subscribed to, one at a time. Optionally, these
 * values may have been projected from a passed `projectResult` argument.
 * @return {Observable} An Observable that emits the result of applying the
 * projection function (and the optional `resultSelector`) to each item emitted
 * by the source Observable and taking values from each projected inner
 * Observable sequentially.
 * @method concatMap
 * @owner Observable
 */
function concatMap(project, resultSelector) {
    return this.lift(new mergeMap_1.MergeMapOperator(project, resultSelector, 1));
}
exports.concatMap = concatMap;
//# sourceMappingURL=concatMap.js.map

/***/ }),
/* 70 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
var async_1 = __webpack_require__(13);
/**
 * Emits a value from the source Observable only after a particular time span
 * has passed without another source emission.
 *
 * <span class="informal">It's like {@link delay}, but passes only the most
 * recent value from each burst of emissions.</span>
 *
 * <img src="./img/debounceTime.png" width="100%">
 *
 * `debounceTime` delays values emitted by the source Observable, but drops
 * previous pending delayed emissions if a new value arrives on the source
 * Observable. This operator keeps track of the most recent value from the
 * source Observable, and emits that only when `dueTime` enough time has passed
 * without any other value appearing on the source Observable. If a new value
 * appears before `dueTime` silence occurs, the previous value will be dropped
 * and will not be emitted on the output Observable.
 *
 * This is a rate-limiting operator, because it is impossible for more than one
 * value to be emitted in any time window of duration `dueTime`, but it is also
 * a delay-like operator since output emissions do not occur at the same time as
 * they did on the source Observable. Optionally takes a {@link IScheduler} for
 * managing timers.
 *
 * @example <caption>Emit the most recent click after a burst of clicks</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var result = clicks.debounceTime(1000);
 * result.subscribe(x => console.log(x));
 *
 * @see {@link auditTime}
 * @see {@link debounce}
 * @see {@link delay}
 * @see {@link sampleTime}
 * @see {@link throttleTime}
 *
 * @param {number} dueTime The timeout duration in milliseconds (or the time
 * unit determined internally by the optional `scheduler`) for the window of
 * time required to wait for emission silence before emitting the most recent
 * source value.
 * @param {Scheduler} [scheduler=async] The {@link IScheduler} to use for
 * managing the timers that handle the timeout for each value.
 * @return {Observable} An Observable that delays the emissions of the source
 * Observable by the specified `dueTime`, and may drop some values if they occur
 * too frequently.
 * @method debounceTime
 * @owner Observable
 */
function debounceTime(dueTime, scheduler) {
    if (scheduler === void 0) { scheduler = async_1.async; }
    return this.lift(new DebounceTimeOperator(dueTime, scheduler));
}
exports.debounceTime = debounceTime;
var DebounceTimeOperator = (function () {
    function DebounceTimeOperator(dueTime, scheduler) {
        this.dueTime = dueTime;
        this.scheduler = scheduler;
    }
    DebounceTimeOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new DebounceTimeSubscriber(subscriber, this.dueTime, this.scheduler));
    };
    return DebounceTimeOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var DebounceTimeSubscriber = (function (_super) {
    __extends(DebounceTimeSubscriber, _super);
    function DebounceTimeSubscriber(destination, dueTime, scheduler) {
        _super.call(this, destination);
        this.dueTime = dueTime;
        this.scheduler = scheduler;
        this.debouncedSubscription = null;
        this.lastValue = null;
        this.hasValue = false;
    }
    DebounceTimeSubscriber.prototype._next = function (value) {
        this.clearDebounce();
        this.lastValue = value;
        this.hasValue = true;
        this.add(this.debouncedSubscription = this.scheduler.schedule(dispatchNext, this.dueTime, this));
    };
    DebounceTimeSubscriber.prototype._complete = function () {
        this.debouncedNext();
        this.destination.complete();
    };
    DebounceTimeSubscriber.prototype.debouncedNext = function () {
        this.clearDebounce();
        if (this.hasValue) {
            this.destination.next(this.lastValue);
            this.lastValue = null;
            this.hasValue = false;
        }
    };
    DebounceTimeSubscriber.prototype.clearDebounce = function () {
        var debouncedSubscription = this.debouncedSubscription;
        if (debouncedSubscription !== null) {
            this.remove(debouncedSubscription);
            debouncedSubscription.unsubscribe();
            this.debouncedSubscription = null;
        }
    };
    return DebounceTimeSubscriber;
}(Subscriber_1.Subscriber));
function dispatchNext(subscriber) {
    subscriber.debouncedNext();
}
//# sourceMappingURL=debounceTime.js.map

/***/ }),
/* 71 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var async_1 = __webpack_require__(13);
var isDate_1 = __webpack_require__(94);
var Subscriber_1 = __webpack_require__(1);
var Notification_1 = __webpack_require__(20);
/**
 * Delays the emission of items from the source Observable by a given timeout or
 * until a given Date.
 *
 * <span class="informal">Time shifts each item by some specified amount of
 * milliseconds.</span>
 *
 * <img src="./img/delay.png" width="100%">
 *
 * If the delay argument is a Number, this operator time shifts the source
 * Observable by that amount of time expressed in milliseconds. The relative
 * time intervals between the values are preserved.
 *
 * If the delay argument is a Date, this operator time shifts the start of the
 * Observable execution until the given date occurs.
 *
 * @example <caption>Delay each click by one second</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var delayedClicks = clicks.delay(1000); // each click emitted after 1 second
 * delayedClicks.subscribe(x => console.log(x));
 *
 * @example <caption>Delay all clicks until a future date happens</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var date = new Date('March 15, 2050 12:00:00'); // in the future
 * var delayedClicks = clicks.delay(date); // click emitted only after that date
 * delayedClicks.subscribe(x => console.log(x));
 *
 * @see {@link debounceTime}
 * @see {@link delayWhen}
 *
 * @param {number|Date} delay The delay duration in milliseconds (a `number`) or
 * a `Date` until which the emission of the source items is delayed.
 * @param {Scheduler} [scheduler=async] The IScheduler to use for
 * managing the timers that handle the time-shift for each item.
 * @return {Observable} An Observable that delays the emissions of the source
 * Observable by the specified timeout or Date.
 * @method delay
 * @owner Observable
 */
function delay(delay, scheduler) {
    if (scheduler === void 0) { scheduler = async_1.async; }
    var absoluteDelay = isDate_1.isDate(delay);
    var delayFor = absoluteDelay ? (+delay - scheduler.now()) : Math.abs(delay);
    return this.lift(new DelayOperator(delayFor, scheduler));
}
exports.delay = delay;
var DelayOperator = (function () {
    function DelayOperator(delay, scheduler) {
        this.delay = delay;
        this.scheduler = scheduler;
    }
    DelayOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new DelaySubscriber(subscriber, this.delay, this.scheduler));
    };
    return DelayOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var DelaySubscriber = (function (_super) {
    __extends(DelaySubscriber, _super);
    function DelaySubscriber(destination, delay, scheduler) {
        _super.call(this, destination);
        this.delay = delay;
        this.scheduler = scheduler;
        this.queue = [];
        this.active = false;
        this.errored = false;
    }
    DelaySubscriber.dispatch = function (state) {
        var source = state.source;
        var queue = source.queue;
        var scheduler = state.scheduler;
        var destination = state.destination;
        while (queue.length > 0 && (queue[0].time - scheduler.now()) <= 0) {
            queue.shift().notification.observe(destination);
        }
        if (queue.length > 0) {
            var delay_1 = Math.max(0, queue[0].time - scheduler.now());
            this.schedule(state, delay_1);
        }
        else {
            source.active = false;
        }
    };
    DelaySubscriber.prototype._schedule = function (scheduler) {
        this.active = true;
        this.add(scheduler.schedule(DelaySubscriber.dispatch, this.delay, {
            source: this, destination: this.destination, scheduler: scheduler
        }));
    };
    DelaySubscriber.prototype.scheduleNotification = function (notification) {
        if (this.errored === true) {
            return;
        }
        var scheduler = this.scheduler;
        var message = new DelayMessage(scheduler.now() + this.delay, notification);
        this.queue.push(message);
        if (this.active === false) {
            this._schedule(scheduler);
        }
    };
    DelaySubscriber.prototype._next = function (value) {
        this.scheduleNotification(Notification_1.Notification.createNext(value));
    };
    DelaySubscriber.prototype._error = function (err) {
        this.errored = true;
        this.queue = [];
        this.destination.error(err);
    };
    DelaySubscriber.prototype._complete = function () {
        this.scheduleNotification(Notification_1.Notification.createComplete());
    };
    return DelaySubscriber;
}(Subscriber_1.Subscriber));
var DelayMessage = (function () {
    function DelayMessage(time, notification) {
        this.time = time;
        this.notification = notification;
    }
    return DelayMessage;
}());
//# sourceMappingURL=delay.js.map

/***/ }),
/* 72 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
var tryCatch_1 = __webpack_require__(18);
var errorObject_1 = __webpack_require__(8);
/* tslint:enable:max-line-length */
/**
 * Returns an Observable that emits all items emitted by the source Observable that are distinct by comparison from the previous item.
 *
 * If a comparator function is provided, then it will be called for each item to test for whether or not that value should be emitted.
 *
 * If a comparator function is not provided, an equality check is used by default.
 *
 * @example <caption>A simple example with numbers</caption>
 * Observable.of(1, 1, 2, 2, 2, 1, 1, 2, 3, 3, 4)
 *   .distinctUntilChanged()
 *   .subscribe(x => console.log(x)); // 1, 2, 1, 2, 3, 4
 *
 * @example <caption>An example using a compare function</caption>
 * interface Person {
 *    age: number,
 *    name: string
 * }
 *
 * Observable.of<Person>(
 *     { age: 4, name: 'Foo'},
 *     { age: 7, name: 'Bar'},
 *     { age: 5, name: 'Foo'})
 *     { age: 6, name: 'Foo'})
 *     .distinctUntilChanged((p: Person, q: Person) => p.name === q.name)
 *     .subscribe(x => console.log(x));
 *
 * // displays:
 * // { age: 4, name: 'Foo' }
 * // { age: 7, name: 'Bar' }
 * // { age: 5, name: 'Foo' }
 *
 * @see {@link distinct}
 * @see {@link distinctUntilKeyChanged}
 *
 * @param {function} [compare] Optional comparison function called to test if an item is distinct from the previous item in the source.
 * @return {Observable} An Observable that emits items from the source Observable with distinct values.
 * @method distinctUntilChanged
 * @owner Observable
 */
function distinctUntilChanged(compare, keySelector) {
    return this.lift(new DistinctUntilChangedOperator(compare, keySelector));
}
exports.distinctUntilChanged = distinctUntilChanged;
var DistinctUntilChangedOperator = (function () {
    function DistinctUntilChangedOperator(compare, keySelector) {
        this.compare = compare;
        this.keySelector = keySelector;
    }
    DistinctUntilChangedOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new DistinctUntilChangedSubscriber(subscriber, this.compare, this.keySelector));
    };
    return DistinctUntilChangedOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var DistinctUntilChangedSubscriber = (function (_super) {
    __extends(DistinctUntilChangedSubscriber, _super);
    function DistinctUntilChangedSubscriber(destination, compare, keySelector) {
        _super.call(this, destination);
        this.keySelector = keySelector;
        this.hasKey = false;
        if (typeof compare === 'function') {
            this.compare = compare;
        }
    }
    DistinctUntilChangedSubscriber.prototype.compare = function (x, y) {
        return x === y;
    };
    DistinctUntilChangedSubscriber.prototype._next = function (value) {
        var keySelector = this.keySelector;
        var key = value;
        if (keySelector) {
            key = tryCatch_1.tryCatch(this.keySelector)(value);
            if (key === errorObject_1.errorObject) {
                return this.destination.error(errorObject_1.errorObject.e);
            }
        }
        var result = false;
        if (this.hasKey) {
            result = tryCatch_1.tryCatch(this.compare)(this.key, key);
            if (result === errorObject_1.errorObject) {
                return this.destination.error(errorObject_1.errorObject.e);
            }
        }
        else {
            this.hasKey = true;
        }
        if (Boolean(result) === false) {
            this.key = key;
            this.destination.next(value);
        }
    };
    return DistinctUntilChangedSubscriber;
}(Subscriber_1.Subscriber));
//# sourceMappingURL=distinctUntilChanged.js.map

/***/ }),
/* 73 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
/* tslint:enable:max-line-length */
/**
 * Perform a side effect for every emission on the source Observable, but return
 * an Observable that is identical to the source.
 *
 * <span class="informal">Intercepts each emission on the source and runs a
 * function, but returns an output which is identical to the source.</span>
 *
 * <img src="./img/do.png" width="100%">
 *
 * Returns a mirrored Observable of the source Observable, but modified so that
 * the provided Observer is called to perform a side effect for every value,
 * error, and completion emitted by the source. Any errors that are thrown in
 * the aforementioned Observer or handlers are safely sent down the error path
 * of the output Observable.
 *
 * This operator is useful for debugging your Observables for the correct values
 * or performing other side effects.
 *
 * Note: this is different to a `subscribe` on the Observable. If the Observable
 * returned by `do` is not subscribed, the side effects specified by the
 * Observer will never happen. `do` therefore simply spies on existing
 * execution, it does not trigger an execution to happen like `subscribe` does.
 *
 * @example <caption>Map every every click to the clientX position of that click, while also logging the click event</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var positions = clicks
 *   .do(ev => console.log(ev))
 *   .map(ev => ev.clientX);
 * positions.subscribe(x => console.log(x));
 *
 * @see {@link map}
 * @see {@link subscribe}
 *
 * @param {Observer|function} [nextOrObserver] A normal Observer object or a
 * callback for `next`.
 * @param {function} [error] Callback for errors in the source.
 * @param {function} [complete] Callback for the completion of the source.
 * @return {Observable} An Observable identical to the source, but runs the
 * specified Observer or callback(s) for each item.
 * @method do
 * @name do
 * @owner Observable
 */
function _do(nextOrObserver, error, complete) {
    return this.lift(new DoOperator(nextOrObserver, error, complete));
}
exports._do = _do;
var DoOperator = (function () {
    function DoOperator(nextOrObserver, error, complete) {
        this.nextOrObserver = nextOrObserver;
        this.error = error;
        this.complete = complete;
    }
    DoOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new DoSubscriber(subscriber, this.nextOrObserver, this.error, this.complete));
    };
    return DoOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var DoSubscriber = (function (_super) {
    __extends(DoSubscriber, _super);
    function DoSubscriber(destination, nextOrObserver, error, complete) {
        _super.call(this, destination);
        var safeSubscriber = new Subscriber_1.Subscriber(nextOrObserver, error, complete);
        safeSubscriber.syncErrorThrowable = true;
        this.add(safeSubscriber);
        this.safeSubscriber = safeSubscriber;
    }
    DoSubscriber.prototype._next = function (value) {
        var safeSubscriber = this.safeSubscriber;
        safeSubscriber.next(value);
        if (safeSubscriber.syncErrorThrown) {
            this.destination.error(safeSubscriber.syncErrorValue);
        }
        else {
            this.destination.next(value);
        }
    };
    DoSubscriber.prototype._error = function (err) {
        var safeSubscriber = this.safeSubscriber;
        safeSubscriber.error(err);
        if (safeSubscriber.syncErrorThrown) {
            this.destination.error(safeSubscriber.syncErrorValue);
        }
        else {
            this.destination.error(err);
        }
    };
    DoSubscriber.prototype._complete = function () {
        var safeSubscriber = this.safeSubscriber;
        safeSubscriber.complete();
        if (safeSubscriber.syncErrorThrown) {
            this.destination.error(safeSubscriber.syncErrorValue);
        }
        else {
            this.destination.complete();
        }
    };
    return DoSubscriber;
}(Subscriber_1.Subscriber));
//# sourceMappingURL=do.js.map

/***/ }),
/* 74 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
/* tslint:enable:max-line-length */
/**
 * Filter items emitted by the source Observable by only emitting those that
 * satisfy a specified predicate.
 *
 * <span class="informal">Like
 * [Array.prototype.filter()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/filter),
 * it only emits a value from the source if it passes a criterion function.</span>
 *
 * <img src="./img/filter.png" width="100%">
 *
 * Similar to the well-known `Array.prototype.filter` method, this operator
 * takes values from the source Observable, passes them through a `predicate`
 * function and only emits those values that yielded `true`.
 *
 * @example <caption>Emit only click events whose target was a DIV element</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var clicksOnDivs = clicks.filter(ev => ev.target.tagName === 'DIV');
 * clicksOnDivs.subscribe(x => console.log(x));
 *
 * @see {@link distinct}
 * @see {@link distinctUntilChanged}
 * @see {@link distinctUntilKeyChanged}
 * @see {@link ignoreElements}
 * @see {@link partition}
 * @see {@link skip}
 *
 * @param {function(value: T, index: number): boolean} predicate A function that
 * evaluates each value emitted by the source Observable. If it returns `true`,
 * the value is emitted, if `false` the value is not passed to the output
 * Observable. The `index` parameter is the number `i` for the i-th source
 * emission that has happened since the subscription, starting from the number
 * `0`.
 * @param {any} [thisArg] An optional argument to determine the value of `this`
 * in the `predicate` function.
 * @return {Observable} An Observable of values from the source that were
 * allowed by the `predicate` function.
 * @method filter
 * @owner Observable
 */
function filter(predicate, thisArg) {
    return this.lift(new FilterOperator(predicate, thisArg));
}
exports.filter = filter;
var FilterOperator = (function () {
    function FilterOperator(predicate, thisArg) {
        this.predicate = predicate;
        this.thisArg = thisArg;
    }
    FilterOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new FilterSubscriber(subscriber, this.predicate, this.thisArg));
    };
    return FilterOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var FilterSubscriber = (function (_super) {
    __extends(FilterSubscriber, _super);
    function FilterSubscriber(destination, predicate, thisArg) {
        _super.call(this, destination);
        this.predicate = predicate;
        this.thisArg = thisArg;
        this.count = 0;
        this.predicate = predicate;
    }
    // the try catch block below is left specifically for
    // optimization and perf reasons. a tryCatcher is not necessary here.
    FilterSubscriber.prototype._next = function (value) {
        var result;
        try {
            result = this.predicate.call(this.thisArg, value, this.count++);
        }
        catch (err) {
            this.destination.error(err);
            return;
        }
        if (result) {
            this.destination.next(value);
        }
    };
    return FilterSubscriber;
}(Subscriber_1.Subscriber));
//# sourceMappingURL=filter.js.map

/***/ }),
/* 75 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
var Subscription_1 = __webpack_require__(4);
/**
 * Returns an Observable that mirrors the source Observable, but will call a specified function when
 * the source terminates on complete or error.
 * @param {function} callback Function to be called when source terminates.
 * @return {Observable} An Observable that mirrors the source, but will call the specified function on termination.
 * @method finally
 * @owner Observable
 */
function _finally(callback) {
    return this.lift(new FinallyOperator(callback));
}
exports._finally = _finally;
var FinallyOperator = (function () {
    function FinallyOperator(callback) {
        this.callback = callback;
    }
    FinallyOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new FinallySubscriber(subscriber, this.callback));
    };
    return FinallyOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var FinallySubscriber = (function (_super) {
    __extends(FinallySubscriber, _super);
    function FinallySubscriber(destination, callback) {
        _super.call(this, destination);
        this.add(new Subscription_1.Subscription(callback));
    }
    return FinallySubscriber;
}(Subscriber_1.Subscriber));
//# sourceMappingURL=finally.js.map

/***/ }),
/* 76 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
var EmptyError_1 = __webpack_require__(91);
/* tslint:enable:max-line-length */
/**
 * Returns an Observable that emits only the last item emitted by the source Observable.
 * It optionally takes a predicate function as a parameter, in which case, rather than emitting
 * the last item from the source Observable, the resulting Observable will emit the last item
 * from the source Observable that satisfies the predicate.
 *
 * <img src="./img/last.png" width="100%">
 *
 * @throws {EmptyError} Delivers an EmptyError to the Observer's `error`
 * callback if the Observable completes before any `next` notification was sent.
 * @param {function} predicate - The condition any source emitted item has to satisfy.
 * @return {Observable} An Observable that emits only the last item satisfying the given condition
 * from the source, or an NoSuchElementException if no such items are emitted.
 * @throws - Throws if no items that match the predicate are emitted by the source Observable.
 * @method last
 * @owner Observable
 */
function last(predicate, resultSelector, defaultValue) {
    return this.lift(new LastOperator(predicate, resultSelector, defaultValue, this));
}
exports.last = last;
var LastOperator = (function () {
    function LastOperator(predicate, resultSelector, defaultValue, source) {
        this.predicate = predicate;
        this.resultSelector = resultSelector;
        this.defaultValue = defaultValue;
        this.source = source;
    }
    LastOperator.prototype.call = function (observer, source) {
        return source.subscribe(new LastSubscriber(observer, this.predicate, this.resultSelector, this.defaultValue, this.source));
    };
    return LastOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var LastSubscriber = (function (_super) {
    __extends(LastSubscriber, _super);
    function LastSubscriber(destination, predicate, resultSelector, defaultValue, source) {
        _super.call(this, destination);
        this.predicate = predicate;
        this.resultSelector = resultSelector;
        this.defaultValue = defaultValue;
        this.source = source;
        this.hasValue = false;
        this.index = 0;
        if (typeof defaultValue !== 'undefined') {
            this.lastValue = defaultValue;
            this.hasValue = true;
        }
    }
    LastSubscriber.prototype._next = function (value) {
        var index = this.index++;
        if (this.predicate) {
            this._tryPredicate(value, index);
        }
        else {
            if (this.resultSelector) {
                this._tryResultSelector(value, index);
                return;
            }
            this.lastValue = value;
            this.hasValue = true;
        }
    };
    LastSubscriber.prototype._tryPredicate = function (value, index) {
        var result;
        try {
            result = this.predicate(value, index, this.source);
        }
        catch (err) {
            this.destination.error(err);
            return;
        }
        if (result) {
            if (this.resultSelector) {
                this._tryResultSelector(value, index);
                return;
            }
            this.lastValue = value;
            this.hasValue = true;
        }
    };
    LastSubscriber.prototype._tryResultSelector = function (value, index) {
        var result;
        try {
            result = this.resultSelector(value, index);
        }
        catch (err) {
            this.destination.error(err);
            return;
        }
        this.lastValue = result;
        this.hasValue = true;
    };
    LastSubscriber.prototype._complete = function () {
        var destination = this.destination;
        if (this.hasValue) {
            destination.next(this.lastValue);
            destination.complete();
        }
        else {
            destination.error(new EmptyError_1.EmptyError);
        }
    };
    return LastSubscriber;
}(Subscriber_1.Subscriber));
//# sourceMappingURL=last.js.map

/***/ }),
/* 77 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
/**
 * Applies a given `project` function to each value emitted by the source
 * Observable, and emits the resulting values as an Observable.
 *
 * <span class="informal">Like [Array.prototype.map()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map),
 * it passes each source value through a transformation function to get
 * corresponding output values.</span>
 *
 * <img src="./img/map.png" width="100%">
 *
 * Similar to the well known `Array.prototype.map` function, this operator
 * applies a projection to each value and emits that projection in the output
 * Observable.
 *
 * @example <caption>Map every every click to the clientX position of that click</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var positions = clicks.map(ev => ev.clientX);
 * positions.subscribe(x => console.log(x));
 *
 * @see {@link mapTo}
 * @see {@link pluck}
 *
 * @param {function(value: T, index: number): R} project The function to apply
 * to each `value` emitted by the source Observable. The `index` parameter is
 * the number `i` for the i-th emission that has happened since the
 * subscription, starting from the number `0`.
 * @param {any} [thisArg] An optional argument to define what `this` is in the
 * `project` function.
 * @return {Observable<R>} An Observable that emits the values from the source
 * Observable transformed by the given `project` function.
 * @method map
 * @owner Observable
 */
function map(project, thisArg) {
    if (typeof project !== 'function') {
        throw new TypeError('argument is not a function. Are you looking for `mapTo()`?');
    }
    return this.lift(new MapOperator(project, thisArg));
}
exports.map = map;
var MapOperator = (function () {
    function MapOperator(project, thisArg) {
        this.project = project;
        this.thisArg = thisArg;
    }
    MapOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new MapSubscriber(subscriber, this.project, this.thisArg));
    };
    return MapOperator;
}());
exports.MapOperator = MapOperator;
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var MapSubscriber = (function (_super) {
    __extends(MapSubscriber, _super);
    function MapSubscriber(destination, project, thisArg) {
        _super.call(this, destination);
        this.project = project;
        this.count = 0;
        this.thisArg = thisArg || this;
    }
    // NOTE: This looks unoptimized, but it's actually purposefully NOT
    // using try/catch optimizations.
    MapSubscriber.prototype._next = function (value) {
        var result;
        try {
            result = this.project.call(this.thisArg, value, this.count++);
        }
        catch (err) {
            this.destination.error(err);
            return;
        }
        this.destination.next(result);
    };
    return MapSubscriber;
}(Subscriber_1.Subscriber));
//# sourceMappingURL=map.js.map

/***/ }),
/* 78 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Observable_1 = __webpack_require__(0);
var ArrayObservable_1 = __webpack_require__(5);
var mergeAll_1 = __webpack_require__(24);
var isScheduler_1 = __webpack_require__(10);
/* tslint:enable:max-line-length */
/**
 * Creates an output Observable which concurrently emits all values from every
 * given input Observable.
 *
 * <span class="informal">Flattens multiple Observables together by blending
 * their values into one Observable.</span>
 *
 * <img src="./img/merge.png" width="100%">
 *
 * `merge` subscribes to each given input Observable (either the source or an
 * Observable given as argument), and simply forwards (without doing any
 * transformation) all the values from all the input Observables to the output
 * Observable. The output Observable only completes once all input Observables
 * have completed. Any error delivered by an input Observable will be immediately
 * emitted on the output Observable.
 *
 * @example <caption>Merge together two Observables: 1s interval and clicks</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var timer = Rx.Observable.interval(1000);
 * var clicksOrTimer = clicks.merge(timer);
 * clicksOrTimer.subscribe(x => console.log(x));
 *
 * @example <caption>Merge together 3 Observables, but only 2 run concurrently</caption>
 * var timer1 = Rx.Observable.interval(1000).take(10);
 * var timer2 = Rx.Observable.interval(2000).take(6);
 * var timer3 = Rx.Observable.interval(500).take(10);
 * var concurrent = 2; // the argument
 * var merged = timer1.merge(timer2, timer3, concurrent);
 * merged.subscribe(x => console.log(x));
 *
 * @see {@link mergeAll}
 * @see {@link mergeMap}
 * @see {@link mergeMapTo}
 * @see {@link mergeScan}
 *
 * @param {ObservableInput} other An input Observable to merge with the source
 * Observable. More than one input Observables may be given as argument.
 * @param {number} [concurrent=Number.POSITIVE_INFINITY] Maximum number of input
 * Observables being subscribed to concurrently.
 * @param {Scheduler} [scheduler=null] The IScheduler to use for managing
 * concurrency of input Observables.
 * @return {Observable} An Observable that emits items that are the result of
 * every input Observable.
 * @method merge
 * @owner Observable
 */
function merge() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        observables[_i - 0] = arguments[_i];
    }
    return this.lift.call(mergeStatic.apply(void 0, [this].concat(observables)));
}
exports.merge = merge;
/* tslint:enable:max-line-length */
/**
 * Creates an output Observable which concurrently emits all values from every
 * given input Observable.
 *
 * <span class="informal">Flattens multiple Observables together by blending
 * their values into one Observable.</span>
 *
 * <img src="./img/merge.png" width="100%">
 *
 * `merge` subscribes to each given input Observable (as arguments), and simply
 * forwards (without doing any transformation) all the values from all the input
 * Observables to the output Observable. The output Observable only completes
 * once all input Observables have completed. Any error delivered by an input
 * Observable will be immediately emitted on the output Observable.
 *
 * @example <caption>Merge together two Observables: 1s interval and clicks</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var timer = Rx.Observable.interval(1000);
 * var clicksOrTimer = Rx.Observable.merge(clicks, timer);
 * clicksOrTimer.subscribe(x => console.log(x));
 *
 * // Results in the following:
 * // timer will emit ascending values, one every second(1000ms) to console
 * // clicks logs MouseEvents to console everytime the "document" is clicked
 * // Since the two streams are merged you see these happening
 * // as they occur.
 *
 * @example <caption>Merge together 3 Observables, but only 2 run concurrently</caption>
 * var timer1 = Rx.Observable.interval(1000).take(10);
 * var timer2 = Rx.Observable.interval(2000).take(6);
 * var timer3 = Rx.Observable.interval(500).take(10);
 * var concurrent = 2; // the argument
 * var merged = Rx.Observable.merge(timer1, timer2, timer3, concurrent);
 * merged.subscribe(x => console.log(x));
 *
 * // Results in the following:
 * // - First timer1 and timer2 will run concurrently
 * // - timer1 will emit a value every 1000ms for 10 iterations
 * // - timer2 will emit a value every 2000ms for 6 iterations
 * // - after timer1 hits it's max iteration, timer2 will
 * //   continue, and timer3 will start to run concurrently with timer2
 * // - when timer2 hits it's max iteration it terminates, and
 * //   timer3 will continue to emit a value every 500ms until it is complete
 *
 * @see {@link mergeAll}
 * @see {@link mergeMap}
 * @see {@link mergeMapTo}
 * @see {@link mergeScan}
 *
 * @param {...ObservableInput} observables Input Observables to merge together.
 * @param {number} [concurrent=Number.POSITIVE_INFINITY] Maximum number of input
 * Observables being subscribed to concurrently.
 * @param {Scheduler} [scheduler=null] The IScheduler to use for managing
 * concurrency of input Observables.
 * @return {Observable} an Observable that emits items that are the result of
 * every input Observable.
 * @static true
 * @name merge
 * @owner Observable
 */
function mergeStatic() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        observables[_i - 0] = arguments[_i];
    }
    var concurrent = Number.POSITIVE_INFINITY;
    var scheduler = null;
    var last = observables[observables.length - 1];
    if (isScheduler_1.isScheduler(last)) {
        scheduler = observables.pop();
        if (observables.length > 1 && typeof observables[observables.length - 1] === 'number') {
            concurrent = observables.pop();
        }
    }
    else if (typeof last === 'number') {
        concurrent = observables.pop();
    }
    if (scheduler === null && observables.length === 1 && observables[0] instanceof Observable_1.Observable) {
        return observables[0];
    }
    return new ArrayObservable_1.ArrayObservable(observables, scheduler).lift(new mergeAll_1.MergeAllOperator(concurrent));
}
exports.mergeStatic = mergeStatic;
//# sourceMappingURL=merge.js.map

/***/ }),
/* 79 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
var Notification_1 = __webpack_require__(20);
/**
 * @see {@link Notification}
 *
 * @param scheduler
 * @param delay
 * @return {Observable<R>|WebSocketSubject<T>|Observable<T>}
 * @method observeOn
 * @owner Observable
 */
function observeOn(scheduler, delay) {
    if (delay === void 0) { delay = 0; }
    return this.lift(new ObserveOnOperator(scheduler, delay));
}
exports.observeOn = observeOn;
var ObserveOnOperator = (function () {
    function ObserveOnOperator(scheduler, delay) {
        if (delay === void 0) { delay = 0; }
        this.scheduler = scheduler;
        this.delay = delay;
    }
    ObserveOnOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new ObserveOnSubscriber(subscriber, this.scheduler, this.delay));
    };
    return ObserveOnOperator;
}());
exports.ObserveOnOperator = ObserveOnOperator;
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var ObserveOnSubscriber = (function (_super) {
    __extends(ObserveOnSubscriber, _super);
    function ObserveOnSubscriber(destination, scheduler, delay) {
        if (delay === void 0) { delay = 0; }
        _super.call(this, destination);
        this.scheduler = scheduler;
        this.delay = delay;
    }
    ObserveOnSubscriber.dispatch = function (arg) {
        var notification = arg.notification, destination = arg.destination;
        notification.observe(destination);
        this.unsubscribe();
    };
    ObserveOnSubscriber.prototype.scheduleMessage = function (notification) {
        this.add(this.scheduler.schedule(ObserveOnSubscriber.dispatch, this.delay, new ObserveOnMessage(notification, this.destination)));
    };
    ObserveOnSubscriber.prototype._next = function (value) {
        this.scheduleMessage(Notification_1.Notification.createNext(value));
    };
    ObserveOnSubscriber.prototype._error = function (err) {
        this.scheduleMessage(Notification_1.Notification.createError(err));
    };
    ObserveOnSubscriber.prototype._complete = function () {
        this.scheduleMessage(Notification_1.Notification.createComplete());
    };
    return ObserveOnSubscriber;
}(Subscriber_1.Subscriber));
exports.ObserveOnSubscriber = ObserveOnSubscriber;
var ObserveOnMessage = (function () {
    function ObserveOnMessage(notification, destination) {
        this.notification = notification;
        this.destination = destination;
    }
    return ObserveOnMessage;
}());
exports.ObserveOnMessage = ObserveOnMessage;
//# sourceMappingURL=observeOn.js.map

/***/ }),
/* 80 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var isArray_1 = __webpack_require__(9);
var ArrayObservable_1 = __webpack_require__(5);
var OuterSubscriber_1 = __webpack_require__(3);
var subscribeToResult_1 = __webpack_require__(6);
/* tslint:enable:max-line-length */
/**
 * Returns an Observable that mirrors the first source Observable to emit an item
 * from the combination of this Observable and supplied Observables.
 * @param {...Observables} ...observables Sources used to race for which Observable emits first.
 * @return {Observable} An Observable that mirrors the output of the first Observable to emit an item.
 * @method race
 * @owner Observable
 */
function race() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        observables[_i - 0] = arguments[_i];
    }
    // if the only argument is an array, it was most likely called with
    // `pair([obs1, obs2, ...])`
    if (observables.length === 1 && isArray_1.isArray(observables[0])) {
        observables = observables[0];
    }
    return this.lift.call(raceStatic.apply(void 0, [this].concat(observables)));
}
exports.race = race;
function raceStatic() {
    var observables = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        observables[_i - 0] = arguments[_i];
    }
    // if the only argument is an array, it was most likely called with
    // `pair([obs1, obs2, ...])`
    if (observables.length === 1) {
        if (isArray_1.isArray(observables[0])) {
            observables = observables[0];
        }
        else {
            return observables[0];
        }
    }
    return new ArrayObservable_1.ArrayObservable(observables).lift(new RaceOperator());
}
exports.raceStatic = raceStatic;
var RaceOperator = (function () {
    function RaceOperator() {
    }
    RaceOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new RaceSubscriber(subscriber));
    };
    return RaceOperator;
}());
exports.RaceOperator = RaceOperator;
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var RaceSubscriber = (function (_super) {
    __extends(RaceSubscriber, _super);
    function RaceSubscriber(destination) {
        _super.call(this, destination);
        this.hasFirst = false;
        this.observables = [];
        this.subscriptions = [];
    }
    RaceSubscriber.prototype._next = function (observable) {
        this.observables.push(observable);
    };
    RaceSubscriber.prototype._complete = function () {
        var observables = this.observables;
        var len = observables.length;
        if (len === 0) {
            this.destination.complete();
        }
        else {
            for (var i = 0; i < len && !this.hasFirst; i++) {
                var observable = observables[i];
                var subscription = subscribeToResult_1.subscribeToResult(this, observable, observable, i);
                if (this.subscriptions) {
                    this.subscriptions.push(subscription);
                }
                this.add(subscription);
            }
            this.observables = null;
        }
    };
    RaceSubscriber.prototype.notifyNext = function (outerValue, innerValue, outerIndex, innerIndex, innerSub) {
        if (!this.hasFirst) {
            this.hasFirst = true;
            for (var i = 0; i < this.subscriptions.length; i++) {
                if (i !== outerIndex) {
                    var subscription = this.subscriptions[i];
                    subscription.unsubscribe();
                    this.remove(subscription);
                }
            }
            this.subscriptions = null;
        }
        this.destination.next(innerValue);
    };
    return RaceSubscriber;
}(OuterSubscriber_1.OuterSubscriber));
exports.RaceSubscriber = RaceSubscriber;
//# sourceMappingURL=race.js.map

/***/ }),
/* 81 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
/**
 * Returns an Observable that skips the first `count` items emitted by the source Observable.
 *
 * <img src="./img/skip.png" width="100%">
 *
 * @param {Number} count - The number of times, items emitted by source Observable should be skipped.
 * @return {Observable} An Observable that skips values emitted by the source Observable.
 *
 * @method skip
 * @owner Observable
 */
function skip(count) {
    return this.lift(new SkipOperator(count));
}
exports.skip = skip;
var SkipOperator = (function () {
    function SkipOperator(total) {
        this.total = total;
    }
    SkipOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new SkipSubscriber(subscriber, this.total));
    };
    return SkipOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var SkipSubscriber = (function (_super) {
    __extends(SkipSubscriber, _super);
    function SkipSubscriber(destination, total) {
        _super.call(this, destination);
        this.total = total;
        this.count = 0;
    }
    SkipSubscriber.prototype._next = function (x) {
        if (++this.count > this.total) {
            this.destination.next(x);
        }
    };
    return SkipSubscriber;
}(Subscriber_1.Subscriber));
//# sourceMappingURL=skip.js.map

/***/ }),
/* 82 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var ArrayObservable_1 = __webpack_require__(5);
var ScalarObservable_1 = __webpack_require__(12);
var EmptyObservable_1 = __webpack_require__(7);
var concat_1 = __webpack_require__(23);
var isScheduler_1 = __webpack_require__(10);
/* tslint:enable:max-line-length */
/**
 * Returns an Observable that emits the items you specify as arguments before it begins to emit
 * items emitted by the source Observable.
 *
 * <img src="./img/startWith.png" width="100%">
 *
 * @param {...T} values - Items you want the modified Observable to emit first.
 * @param {Scheduler} [scheduler] - A {@link IScheduler} to use for scheduling
 * the emissions of the `next` notifications.
 * @return {Observable} An Observable that emits the items in the specified Iterable and then emits the items
 * emitted by the source Observable.
 * @method startWith
 * @owner Observable
 */
function startWith() {
    var array = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        array[_i - 0] = arguments[_i];
    }
    var scheduler = array[array.length - 1];
    if (isScheduler_1.isScheduler(scheduler)) {
        array.pop();
    }
    else {
        scheduler = null;
    }
    var len = array.length;
    if (len === 1) {
        return concat_1.concatStatic(new ScalarObservable_1.ScalarObservable(array[0], scheduler), this);
    }
    else if (len > 1) {
        return concat_1.concatStatic(new ArrayObservable_1.ArrayObservable(array, scheduler), this);
    }
    else {
        return concat_1.concatStatic(new EmptyObservable_1.EmptyObservable(scheduler), this);
    }
}
exports.startWith = startWith;
//# sourceMappingURL=startWith.js.map

/***/ }),
/* 83 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
var ArgumentOutOfRangeError_1 = __webpack_require__(90);
var EmptyObservable_1 = __webpack_require__(7);
/**
 * Emits only the first `count` values emitted by the source Observable.
 *
 * <span class="informal">Takes the first `count` values from the source, then
 * completes.</span>
 *
 * <img src="./img/take.png" width="100%">
 *
 * `take` returns an Observable that emits only the first `count` values emitted
 * by the source Observable. If the source emits fewer than `count` values then
 * all of its values are emitted. After that, it completes, regardless if the
 * source completes.
 *
 * @example <caption>Take the first 5 seconds of an infinite 1-second interval Observable</caption>
 * var interval = Rx.Observable.interval(1000);
 * var five = interval.take(5);
 * five.subscribe(x => console.log(x));
 *
 * @see {@link takeLast}
 * @see {@link takeUntil}
 * @see {@link takeWhile}
 * @see {@link skip}
 *
 * @throws {ArgumentOutOfRangeError} When using `take(i)`, it delivers an
 * ArgumentOutOrRangeError to the Observer's `error` callback if `i < 0`.
 *
 * @param {number} count The maximum number of `next` values to emit.
 * @return {Observable<T>} An Observable that emits only the first `count`
 * values emitted by the source Observable, or all of the values from the source
 * if the source emits fewer than `count` values.
 * @method take
 * @owner Observable
 */
function take(count) {
    if (count === 0) {
        return new EmptyObservable_1.EmptyObservable();
    }
    else {
        return this.lift(new TakeOperator(count));
    }
}
exports.take = take;
var TakeOperator = (function () {
    function TakeOperator(total) {
        this.total = total;
        if (this.total < 0) {
            throw new ArgumentOutOfRangeError_1.ArgumentOutOfRangeError;
        }
    }
    TakeOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new TakeSubscriber(subscriber, this.total));
    };
    return TakeOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var TakeSubscriber = (function (_super) {
    __extends(TakeSubscriber, _super);
    function TakeSubscriber(destination, total) {
        _super.call(this, destination);
        this.total = total;
        this.count = 0;
    }
    TakeSubscriber.prototype._next = function (value) {
        var total = this.total;
        var count = ++this.count;
        if (count <= total) {
            this.destination.next(value);
            if (count === total) {
                this.destination.complete();
                this.unsubscribe();
            }
        }
    };
    return TakeSubscriber;
}(Subscriber_1.Subscriber));
//# sourceMappingURL=take.js.map

/***/ }),
/* 84 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var OuterSubscriber_1 = __webpack_require__(3);
var subscribeToResult_1 = __webpack_require__(6);
/**
 * Emits the values emitted by the source Observable until a `notifier`
 * Observable emits a value.
 *
 * <span class="informal">Lets values pass until a second Observable,
 * `notifier`, emits something. Then, it completes.</span>
 *
 * <img src="./img/takeUntil.png" width="100%">
 *
 * `takeUntil` subscribes and begins mirroring the source Observable. It also
 * monitors a second Observable, `notifier` that you provide. If the `notifier`
 * emits a value or a complete notification, the output Observable stops
 * mirroring the source Observable and completes.
 *
 * @example <caption>Tick every second until the first click happens</caption>
 * var interval = Rx.Observable.interval(1000);
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var result = interval.takeUntil(clicks);
 * result.subscribe(x => console.log(x));
 *
 * @see {@link take}
 * @see {@link takeLast}
 * @see {@link takeWhile}
 * @see {@link skip}
 *
 * @param {Observable} notifier The Observable whose first emitted value will
 * cause the output Observable of `takeUntil` to stop emitting values from the
 * source Observable.
 * @return {Observable<T>} An Observable that emits the values from the source
 * Observable until such time as `notifier` emits its first value.
 * @method takeUntil
 * @owner Observable
 */
function takeUntil(notifier) {
    return this.lift(new TakeUntilOperator(notifier));
}
exports.takeUntil = takeUntil;
var TakeUntilOperator = (function () {
    function TakeUntilOperator(notifier) {
        this.notifier = notifier;
    }
    TakeUntilOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new TakeUntilSubscriber(subscriber, this.notifier));
    };
    return TakeUntilOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var TakeUntilSubscriber = (function (_super) {
    __extends(TakeUntilSubscriber, _super);
    function TakeUntilSubscriber(destination, notifier) {
        _super.call(this, destination);
        this.notifier = notifier;
        this.add(subscribeToResult_1.subscribeToResult(this, notifier));
    }
    TakeUntilSubscriber.prototype.notifyNext = function (outerValue, innerValue, outerIndex, innerIndex, innerSub) {
        this.complete();
    };
    TakeUntilSubscriber.prototype.notifyComplete = function () {
        // noop
    };
    return TakeUntilSubscriber;
}(OuterSubscriber_1.OuterSubscriber));
//# sourceMappingURL=takeUntil.js.map

/***/ }),
/* 85 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscriber_1 = __webpack_require__(1);
/**
 * @return {Observable<any[]>|WebSocketSubject<T>|Observable<T>}
 * @method toArray
 * @owner Observable
 */
function toArray() {
    return this.lift(new ToArrayOperator());
}
exports.toArray = toArray;
var ToArrayOperator = (function () {
    function ToArrayOperator() {
    }
    ToArrayOperator.prototype.call = function (subscriber, source) {
        return source.subscribe(new ToArraySubscriber(subscriber));
    };
    return ToArrayOperator;
}());
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var ToArraySubscriber = (function (_super) {
    __extends(ToArraySubscriber, _super);
    function ToArraySubscriber(destination) {
        _super.call(this, destination);
        this.array = [];
    }
    ToArraySubscriber.prototype._next = function (x) {
        this.array.push(x);
    };
    ToArraySubscriber.prototype._complete = function () {
        this.destination.next(this.array);
        this.destination.complete();
    };
    return ToArraySubscriber;
}(Subscriber_1.Subscriber));
//# sourceMappingURL=toArray.js.map

/***/ }),
/* 86 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var root_1 = __webpack_require__(2);
/* tslint:enable:max-line-length */
/**
 * Converts an Observable sequence to a ES2015 compliant promise.
 *
 * @example
 * // Using normal ES2015
 * let source = Rx.Observable
 *   .just(42)
 *   .toPromise();
 *
 * source.then((value) => console.log('Value: %s', value));
 * // => Value: 42
 *
 * // Rejected Promise
 * // Using normal ES2015
 * let source = Rx.Observable
 *   .throw(new Error('woops'))
 *   .toPromise();
 *
 * source
 *   .then((value) => console.log('Value: %s', value))
 *   .catch((err) => console.log('Error: %s', err));
 * // => Error: Error: woops
 *
 * // Setting via the config
 * Rx.config.Promise = RSVP.Promise;
 *
 * let source = Rx.Observable
 *   .of(42)
 *   .toPromise();
 *
 * source.then((value) => console.log('Value: %s', value));
 * // => Value: 42
 *
 * // Setting via the method
 * let source = Rx.Observable
 *   .just(42)
 *   .toPromise(RSVP.Promise);
 *
 * source.then((value) => console.log('Value: %s', value));
 * // => Value: 42
 *
 * @param PromiseCtor promise The constructor of the promise. If not provided,
 * it will look for a constructor first in Rx.config.Promise then fall back to
 * the native Promise constructor if available.
 * @return {Promise<T>} An ES2015 compatible promise with the last value from
 * the observable sequence.
 * @method toPromise
 * @owner Observable
 */
function toPromise(PromiseCtor) {
    var _this = this;
    if (!PromiseCtor) {
        if (root_1.root.Rx && root_1.root.Rx.config && root_1.root.Rx.config.Promise) {
            PromiseCtor = root_1.root.Rx.config.Promise;
        }
        else if (root_1.root.Promise) {
            PromiseCtor = root_1.root.Promise;
        }
    }
    if (!PromiseCtor) {
        throw new Error('no Promise impl found');
    }
    return new PromiseCtor(function (resolve, reject) {
        var value;
        _this.subscribe(function (x) { return value = x; }, function (err) { return reject(err); }, function () { return resolve(value); });
    });
}
exports.toPromise = toPromise;
//# sourceMappingURL=toPromise.js.map

/***/ }),
/* 87 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Subscription_1 = __webpack_require__(4);
/**
 * A unit of work to be executed in a {@link Scheduler}. An action is typically
 * created from within a Scheduler and an RxJS user does not need to concern
 * themselves about creating and manipulating an Action.
 *
 * ```ts
 * class Action<T> extends Subscription {
 *   new (scheduler: Scheduler, work: (state?: T) => void);
 *   schedule(state?: T, delay: number = 0): Subscription;
 * }
 * ```
 *
 * @class Action<T>
 */
var Action = (function (_super) {
    __extends(Action, _super);
    function Action(scheduler, work) {
        _super.call(this);
    }
    /**
     * Schedules this action on its parent Scheduler for execution. May be passed
     * some context object, `state`. May happen at some point in the future,
     * according to the `delay` parameter, if specified.
     * @param {T} [state] Some contextual data that the `work` function uses when
     * called by the Scheduler.
     * @param {number} [delay] Time to wait before executing the work, where the
     * time unit is implicit and defined by the Scheduler.
     * @return {void}
     */
    Action.prototype.schedule = function (state, delay) {
        if (delay === void 0) { delay = 0; }
        return this;
    };
    return Action;
}(Subscription_1.Subscription));
exports.Action = Action;
//# sourceMappingURL=Action.js.map

/***/ }),
/* 88 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var root_1 = __webpack_require__(2);
var Action_1 = __webpack_require__(87);
/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
var AsyncAction = (function (_super) {
    __extends(AsyncAction, _super);
    function AsyncAction(scheduler, work) {
        _super.call(this, scheduler, work);
        this.scheduler = scheduler;
        this.work = work;
        this.pending = false;
    }
    AsyncAction.prototype.schedule = function (state, delay) {
        if (delay === void 0) { delay = 0; }
        if (this.closed) {
            return this;
        }
        // Always replace the current state with the new state.
        this.state = state;
        // Set the pending flag indicating that this action has been scheduled, or
        // has recursively rescheduled itself.
        this.pending = true;
        var id = this.id;
        var scheduler = this.scheduler;
        //
        // Important implementation note:
        //
        // Actions only execute once by default, unless rescheduled from within the
        // scheduled callback. This allows us to implement single and repeat
        // actions via the same code path, without adding API surface area, as well
        // as mimic traditional recursion but across asynchronous boundaries.
        //
        // However, JS runtimes and timers distinguish between intervals achieved by
        // serial `setTimeout` calls vs. a single `setInterval` call. An interval of
        // serial `setTimeout` calls can be individually delayed, which delays
        // scheduling the next `setTimeout`, and so on. `setInterval` attempts to
        // guarantee the interval callback will be invoked more precisely to the
        // interval period, regardless of load.
        //
        // Therefore, we use `setInterval` to schedule single and repeat actions.
        // If the action reschedules itself with the same delay, the interval is not
        // canceled. If the action doesn't reschedule, or reschedules with a
        // different delay, the interval will be canceled after scheduled callback
        // execution.
        //
        if (id != null) {
            this.id = this.recycleAsyncId(scheduler, id, delay);
        }
        this.delay = delay;
        // If this action has already an async Id, don't request a new one.
        this.id = this.id || this.requestAsyncId(scheduler, this.id, delay);
        return this;
    };
    AsyncAction.prototype.requestAsyncId = function (scheduler, id, delay) {
        if (delay === void 0) { delay = 0; }
        return root_1.root.setInterval(scheduler.flush.bind(scheduler, this), delay);
    };
    AsyncAction.prototype.recycleAsyncId = function (scheduler, id, delay) {
        if (delay === void 0) { delay = 0; }
        // If this action is rescheduled with the same delay time, don't clear the interval id.
        if (delay !== null && this.delay === delay) {
            return id;
        }
        // Otherwise, if the action's delay time is different from the current delay,
        // clear the interval id
        return root_1.root.clearInterval(id) && undefined || undefined;
    };
    /**
     * Immediately executes this action and the `work` it contains.
     * @return {any}
     */
    AsyncAction.prototype.execute = function (state, delay) {
        if (this.closed) {
            return new Error('executing a cancelled action');
        }
        this.pending = false;
        var error = this._execute(state, delay);
        if (error) {
            return error;
        }
        else if (this.pending === false && this.id != null) {
            // Dequeue if the action didn't reschedule itself. Don't call
            // unsubscribe(), because the action could reschedule later.
            // For example:
            // ```
            // scheduler.schedule(function doWork(counter) {
            //   /* ... I'm a busy worker bee ... */
            //   var originalAction = this;
            //   /* wait 100ms before rescheduling the action */
            //   setTimeout(function () {
            //     originalAction.schedule(counter + 1);
            //   }, 100);
            // }, 1000);
            // ```
            this.id = this.recycleAsyncId(this.scheduler, this.id, null);
        }
    };
    AsyncAction.prototype._execute = function (state, delay) {
        var errored = false;
        var errorValue = undefined;
        try {
            this.work(state);
        }
        catch (e) {
            errored = true;
            errorValue = !!e && e || new Error(e);
        }
        if (errored) {
            this.unsubscribe();
            return errorValue;
        }
    };
    AsyncAction.prototype._unsubscribe = function () {
        var id = this.id;
        var scheduler = this.scheduler;
        var actions = scheduler.actions;
        var index = actions.indexOf(this);
        this.work = null;
        this.delay = null;
        this.state = null;
        this.pending = false;
        this.scheduler = null;
        if (index !== -1) {
            actions.splice(index, 1);
        }
        if (id != null) {
            this.id = this.recycleAsyncId(scheduler, id, null);
        }
    };
    return AsyncAction;
}(Action_1.Action));
exports.AsyncAction = AsyncAction;
//# sourceMappingURL=AsyncAction.js.map

/***/ }),
/* 89 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Scheduler_1 = __webpack_require__(56);
var AsyncScheduler = (function (_super) {
    __extends(AsyncScheduler, _super);
    function AsyncScheduler() {
        _super.apply(this, arguments);
        this.actions = [];
        /**
         * A flag to indicate whether the Scheduler is currently executing a batch of
         * queued actions.
         * @type {boolean}
         */
        this.active = false;
        /**
         * An internal ID used to track the latest asynchronous task such as those
         * coming from `setTimeout`, `setInterval`, `requestAnimationFrame`, and
         * others.
         * @type {any}
         */
        this.scheduled = undefined;
    }
    AsyncScheduler.prototype.flush = function (action) {
        var actions = this.actions;
        if (this.active) {
            actions.push(action);
            return;
        }
        var error;
        this.active = true;
        do {
            if (error = action.execute(action.state, action.delay)) {
                break;
            }
        } while (action = actions.shift()); // exhaust the scheduler queue
        this.active = false;
        if (error) {
            while (action = actions.shift()) {
                action.unsubscribe();
            }
            throw error;
        }
    };
    return AsyncScheduler;
}(Scheduler_1.Scheduler));
exports.AsyncScheduler = AsyncScheduler;
//# sourceMappingURL=AsyncScheduler.js.map

/***/ }),
/* 90 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
/**
 * An error thrown when an element was queried at a certain index of an
 * Observable, but no such index or position exists in that sequence.
 *
 * @see {@link elementAt}
 * @see {@link take}
 * @see {@link takeLast}
 *
 * @class ArgumentOutOfRangeError
 */
var ArgumentOutOfRangeError = (function (_super) {
    __extends(ArgumentOutOfRangeError, _super);
    function ArgumentOutOfRangeError() {
        var err = _super.call(this, 'argument out of range');
        this.name = err.name = 'ArgumentOutOfRangeError';
        this.stack = err.stack;
        this.message = err.message;
    }
    return ArgumentOutOfRangeError;
}(Error));
exports.ArgumentOutOfRangeError = ArgumentOutOfRangeError;
//# sourceMappingURL=ArgumentOutOfRangeError.js.map

/***/ }),
/* 91 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
/**
 * An error thrown when an Observable or a sequence was queried but has no
 * elements.
 *
 * @see {@link first}
 * @see {@link last}
 * @see {@link single}
 *
 * @class EmptyError
 */
var EmptyError = (function (_super) {
    __extends(EmptyError, _super);
    function EmptyError() {
        var err = _super.call(this, 'no elements in sequence');
        this.name = err.name = 'EmptyError';
        this.stack = err.stack;
        this.message = err.message;
    }
    return EmptyError;
}(Error));
exports.EmptyError = EmptyError;
//# sourceMappingURL=EmptyError.js.map

/***/ }),
/* 92 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
/**
 * An error thrown when an action is invalid because the object has been
 * unsubscribed.
 *
 * @see {@link Subject}
 * @see {@link BehaviorSubject}
 *
 * @class ObjectUnsubscribedError
 */
var ObjectUnsubscribedError = (function (_super) {
    __extends(ObjectUnsubscribedError, _super);
    function ObjectUnsubscribedError() {
        var err = _super.call(this, 'object unsubscribed');
        this.name = err.name = 'ObjectUnsubscribedError';
        this.stack = err.stack;
        this.message = err.message;
    }
    return ObjectUnsubscribedError;
}(Error));
exports.ObjectUnsubscribedError = ObjectUnsubscribedError;
//# sourceMappingURL=ObjectUnsubscribedError.js.map

/***/ }),
/* 93 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
/**
 * An error thrown when one or more errors have occurred during the
 * `unsubscribe` of a {@link Subscription}.
 */
var UnsubscriptionError = (function (_super) {
    __extends(UnsubscriptionError, _super);
    function UnsubscriptionError(errors) {
        _super.call(this);
        this.errors = errors;
        var err = Error.call(this, errors ?
            errors.length + " errors occurred during unsubscription:\n  " + errors.map(function (err, i) { return ((i + 1) + ") " + err.toString()); }).join('\n  ') : '');
        this.name = err.name = 'UnsubscriptionError';
        this.stack = err.stack;
        this.message = err.message;
    }
    return UnsubscriptionError;
}(Error));
exports.UnsubscriptionError = UnsubscriptionError;
//# sourceMappingURL=UnsubscriptionError.js.map

/***/ }),
/* 94 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

function isDate(value) {
    return value instanceof Date && !isNaN(+value);
}
exports.isDate = isDate;
//# sourceMappingURL=isDate.js.map

/***/ }),
/* 95 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var isArray_1 = __webpack_require__(9);
function isNumeric(val) {
    // parseFloat NaNs numeric-cast false positives (null|true|false|"")
    // ...but misinterprets leading-number strings, particularly hex literals ("0x...")
    // subtraction forces infinities to NaN
    // adding 1 corrects loss of precision from parseFloat (#15100)
    return !isArray_1.isArray(val) && (val - parseFloat(val) + 1) >= 0;
}
exports.isNumeric = isNumeric;
;
//# sourceMappingURL=isNumeric.js.map

/***/ }),
/* 96 */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

var Subscriber_1 = __webpack_require__(1);
var rxSubscriber_1 = __webpack_require__(16);
var Observer_1 = __webpack_require__(21);
function toSubscriber(nextOrObserver, error, complete) {
    if (nextOrObserver) {
        if (nextOrObserver instanceof Subscriber_1.Subscriber) {
            return nextOrObserver;
        }
        if (nextOrObserver[rxSubscriber_1.rxSubscriber]) {
            return nextOrObserver[rxSubscriber_1.rxSubscriber]();
        }
    }
    if (!nextOrObserver && !error && !complete) {
        return new Subscriber_1.Subscriber(Observer_1.empty);
    }
    return new Subscriber_1.Subscriber(nextOrObserver, error, complete);
}
exports.toSubscriber = toSubscriber;
//# sourceMappingURL=toSubscriber.js.map

/***/ }),
/* 97 */
/***/ (function(module, exports) {

var g;

// This works in non-strict mode
g = (function() {
	return this;
})();

try {
	// This works if eval is allowed (see CSP)
	g = g || Function("return this")() || (1,eval)("this");
} catch(e) {
	// This works if the window reference is available
	if(typeof window === "object")
		g = window;
}

// g can still be undefined, but nothing to do about it...
// We return undefined, instead of nothing here, so it's
// easier to handle this case. if(!global) { ...}

module.exports = g;


/***/ }),
/* 98 */
/***/ (function(module, __webpack_exports__, __webpack_require__) {

"use strict";
Object.defineProperty(__webpack_exports__, "__esModule", { value: true });
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_0_rxjs_Subject__ = __webpack_require__(29);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_0_rxjs_Subject___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_0_rxjs_Subject__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_1_rxjs_Observable__ = __webpack_require__(0);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_1_rxjs_Observable___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_1_rxjs_Observable__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_2_rxjs_observable_FromObservable__ = __webpack_require__(19);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_2_rxjs_observable_FromObservable___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_2_rxjs_observable_FromObservable__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_3_rxjs_add_operator_map__ = __webpack_require__(45);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_3_rxjs_add_operator_map___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_3_rxjs_add_operator_map__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_4_rxjs_add_operator_filter__ = __webpack_require__(42);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_4_rxjs_add_operator_filter___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_4_rxjs_add_operator_filter__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_5_rxjs_add_operator_catch__ = __webpack_require__(36);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_5_rxjs_add_operator_catch___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_5_rxjs_add_operator_catch__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_6_rxjs_add_operator_do__ = __webpack_require__(41);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_6_rxjs_add_operator_do___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_6_rxjs_add_operator_do__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_7_rxjs_add_operator_merge__ = __webpack_require__(46);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_7_rxjs_add_operator_merge___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_7_rxjs_add_operator_merge__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_8_rxjs_add_operator_concat__ = __webpack_require__(11);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_8_rxjs_add_operator_concat___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_8_rxjs_add_operator_concat__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_9_rxjs_add_operator_mergeMap__ = __webpack_require__(47);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_9_rxjs_add_operator_mergeMap___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_9_rxjs_add_operator_mergeMap__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_10_rxjs_add_operator_concatMap__ = __webpack_require__(37);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_10_rxjs_add_operator_concatMap___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_10_rxjs_add_operator_concatMap__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_11_rxjs_add_operator_startWith__ = __webpack_require__(50);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_11_rxjs_add_operator_startWith___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_11_rxjs_add_operator_startWith__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_12_rxjs_add_operator_takeUntil__ = __webpack_require__(52);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_12_rxjs_add_operator_takeUntil___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_12_rxjs_add_operator_takeUntil__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_13_rxjs_add_observable_fromPromise__ = __webpack_require__(32);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_13_rxjs_add_observable_fromPromise___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_13_rxjs_add_observable_fromPromise__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_14_rxjs_add_observable_fromEvent__ = __webpack_require__(31);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_14_rxjs_add_observable_fromEvent___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_14_rxjs_add_observable_fromEvent__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_15_rxjs_add_observable_from__ = __webpack_require__(30);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_15_rxjs_add_observable_from___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_15_rxjs_add_observable_from__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_16_rxjs_add_observable_of__ = __webpack_require__(34);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_16_rxjs_add_observable_of___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_16_rxjs_add_observable_of__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_17_rxjs_add_observable_interval__ = __webpack_require__(33);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_17_rxjs_add_observable_interval___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_17_rxjs_add_observable_interval__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_18_rxjs_add_operator_distinctUntilChanged__ = __webpack_require__(40);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_18_rxjs_add_operator_distinctUntilChanged___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_18_rxjs_add_operator_distinctUntilChanged__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_19_rxjs_add_operator_debounceTime__ = __webpack_require__(38);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_19_rxjs_add_operator_debounceTime___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_19_rxjs_add_operator_debounceTime__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_20_rxjs_add_operator_buffer__ = __webpack_require__(35);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_20_rxjs_add_operator_buffer___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_20_rxjs_add_operator_buffer__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_21_rxjs_add_operator_skip__ = __webpack_require__(49);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_21_rxjs_add_operator_skip___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_21_rxjs_add_operator_skip__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_22_rxjs_add_operator_last__ = __webpack_require__(44);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_22_rxjs_add_operator_last___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_22_rxjs_add_operator_last__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_23_rxjs_add_operator_delay__ = __webpack_require__(39);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_23_rxjs_add_operator_delay___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_23_rxjs_add_operator_delay__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_24_rxjs_add_operator_take__ = __webpack_require__(51);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_24_rxjs_add_operator_take___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_24_rxjs_add_operator_take__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_25_rxjs_add_operator_toArray__ = __webpack_require__(53);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_25_rxjs_add_operator_toArray___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_25_rxjs_add_operator_toArray__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_26_rxjs_add_operator_toPromise__ = __webpack_require__(54);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_26_rxjs_add_operator_toPromise___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_26_rxjs_add_operator_toPromise__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_27_rxjs_add_operator_race__ = __webpack_require__(48);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_27_rxjs_add_operator_race___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_27_rxjs_add_operator_race__);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_28_rxjs_add_operator_finally__ = __webpack_require__(43);
/* harmony import */ var __WEBPACK_IMPORTED_MODULE_28_rxjs_add_operator_finally___default = __webpack_require__.n(__WEBPACK_IMPORTED_MODULE_28_rxjs_add_operator_finally__);

































jb.rx.Observable = __WEBPACK_IMPORTED_MODULE_1_rxjs_Observable__["Observable"];
jb.rx.Subject = __WEBPACK_IMPORTED_MODULE_0_rxjs_Subject__["Subject"];


/***/ })
/******/ ]);;

(function(){

var ui = jb.ui;

ui.ctrl = function(context,options) {
	var ctx = context.setVars({ $model: context.params });
	var styleOptions = defaultStyle(ctx) || {};
	if (styleOptions.jbExtend)  {// style by control
		styleOptions.ctxForPick = ctx;
		return styleOptions.jbExtend(options).applyFeatures(ctx);
	}
	return new JbComponent(ctx).jbExtend(options).jbExtend(styleOptions).applyFeatures(ctx);

	function defaultStyle(ctx) {
		var profile = context.profile;
		var defaultVar = '$theme.' + (profile.$ || '');
		if (!profile.style && context.vars[defaultVar])
			return ctx.run({$:context.vars[defaultVar]})
		return context.params.style ? context.params.style(ctx) : {};
	}
}

var cssId = 0;
var cssSelectors_hash = {};

class JbComponent {
	constructor(ctx) {
		this.ctx = ctx;
		Object.assign(this, {jbInitFuncs: [], jbBeforeInitFuncs: [], jbRegisterEventsFuncs:[], jbAfterViewInitFuncs: [],
			jbCheckFuncs: [],jbDestroyFuncs: [], extendCtxFuncs: [], extendCtxOnceFuncs: [], modifierFuncs: [], extendItemFuncs: [] });
		this.cssSelectors = [];

		this.jb_profile = ctx.profile;
		var title = jb.tosingle(jb.val(this.ctx.params.title)) || (() => '');
		this.jb_title = (typeof title == 'function') ? title : () => ''+title;
//		this.jb$title = (typeof title == 'function') ? title() : title; // for debug
	}

	reactComp() {
		var jbComp = this;
		class ReactComp extends ui.Component {
			constructor(props) {
				super();
				this.jbComp = jbComp;
				this.ctx = this.originalCtx = jbComp.ctx; // this.ctx is re-calculated
				this.ctxForPick = jbComp.ctxForPick || jbComp.ctx;
				this.destroyed = new Promise(resolve=>this.resolveDestroyed = resolve);
				try {
					if (jbComp.createjbEmitter)
						this.jbEmitter = this.jbEmitter || new jb.rx.Subject();
		    		this.refreshCtx = _ => {
						jbComp.extendCtxFuncs.forEach(extendCtx => {
			    			this.ctx = extendCtx(this.ctx,this) || this.ctx;
			    		})
			    		return this.ctx;
			    	}
					jbComp.extendCtxOnceFuncs.forEach(extendCtx =>
		    			this.ctx = extendCtx(this.ctx,this) || this.ctx);
			    	this.refreshCtx();
					Object.assign(this,(jbComp.styleCtx || {}).params); // assign style params to cmp
					jbComp.jbBeforeInitFuncs.forEach(init=> init(this,props));
					jbComp.jbInitFuncs.forEach(init=> init(this,props));
			    } catch(e) { jb.logException(e,'') }
			}
			render(props,state) {
				jb.logPerformance('render',state,props,this);
				if (!jbComp.template || typeof jbComp.template != 'function')
					return ui.h('span',{display: 'none'});
				//console.log('render',jb.studio.shortTitle(this.ctx.path));
				try {
					var vdom = jbComp.template(this,state,ui.h);
					jbComp.modifierFuncs.forEach(modifier=> {
						if (typeof vdom == 'object')
							vdom = modifier(vdom,this,state) || vdom
					});
					return vdom;
				} catch (e) {
					jb.logException('render',e);
					return ui.h('span',{display: 'none'});
				}
			}
    		componentDidMount() {
				jbComp.injectCss(this);
				jbComp.jbRegisterEventsFuncs.forEach(init=> init(this));
				jbComp.jbAfterViewInitFuncs.forEach(init=> init(this));
				if (this.jbEmitter)
					this.jbEmitter.next('after-init');
			}
	  		componentWillUnmount() {
				jbComp.jbDestroyFuncs.forEach(f=>
					f(this));
				if (this.jbEmitter) {
					 this.jbEmitter.next('destroy');
					 this.jbEmitter.complete();
				}
				this.resolveDestroyed();
			}
		};
		injectLifeCycleMethods(ReactComp,this);
		ReactComp.ctx = this.ctx;
		ReactComp.title = this.jb_title();
		ReactComp.jbComp = jbComp;
		return ReactComp;
	}

	injectCss(cmp) {
		var elem = cmp.base;
		if (!elem || !elem.setAttribute)
			return;
		var ctx = this.ctx;
	  	while (ctx.profile.__innerImplementation)
	  		ctx = ctx.componentContext._parent;
	  	var attachedCtx = this.ctxForPick || ctx;
	  	elem.setAttribute('jb-ctx',attachedCtx.id);
		ui.garbageCollectCtxDictionary();
		jb.ctxDictionary[attachedCtx.id] = attachedCtx;

		if (this.cssSelectors && this.cssSelectors.length > 0) {
			var cssKey = this.cssSelectors.join('\n');
			if (!cssSelectors_hash[cssKey]) {
				cssId++;
				cssSelectors_hash[cssKey] = cssId;
				var cssStyle = this.cssSelectors.map(selectorPlusExp=>{
					var selector = selectorPlusExp.split('{')[0];
					var fixed_selector = selector.split(',').map(x=>x.trim()).map(x=>`.jb-${cssId}${x}`);
					return fixed_selector + ' { ' + selectorPlusExp.split('{')[1];
				}).join('\n');
				var remark = `/*style: ${ctx.profile.style && ctx.profile.style.$}, path: ${ctx.path}*/\n`;
        var style_elem = document.createElement('style');
        style_elem.innerHTML = remark + cssStyle;
        document.head.appendChild(style_elem);
			}
			elem.classList.add(`jb-${cssSelectors_hash[cssKey]}`);
		}
	}

	applyFeatures(context) {
		var features = (context.params.features && context.params.features(context) || []);
		features.forEach(f => this.jbExtend(f,context));
		if (context.params.style && context.params.style.profile && context.params.style.profile.features) {
			jb.toarray(context.params.style.profile.features)
				.forEach((f,i)=>
					this.jbExtend(context.runInner(f,{type:'feature'},context.path+'~features~'+i),context))
		}
		return this;
	}

	jbExtend(options,context) {
    	if (!options) return this;
    	context = context || this.ctx;
    	if (!context)
    		console.log('no context provided for jbExtend');
    	if (typeof options != 'object')
    		debugger;

    	this.template = this.template || options.template;

		if (options.beforeInit) this.jbBeforeInitFuncs.push(options.beforeInit);
		if (options.init) this.jbInitFuncs.push(options.init);
		if (options.afterViewInit) this.jbAfterViewInitFuncs.push(options.afterViewInit);
		if (options.doCheck) this.jbCheckFuncs.push(options.doCheck);
		if (options.destroy) this.jbDestroyFuncs.push(options.destroy);
		if (options.templateModifier) this.modifierFuncs.push(options.templateModifier);
		if (typeof options.class == 'string')
			this.modifierFuncs.push(vdom=> ui.addClassToVdom(vdom,options.class));
		if (typeof options.class == 'function')
			this.modifierFuncs.push(vdom=> ui.addClassToVdom(vdom,options.class()));
		// events
		var events = Object.getOwnPropertyNames(options).filter(op=>op.indexOf('on') == 0);
		events.forEach(op=>
			this.jbRegisterEventsFuncs.push(cmp=>
		       	  cmp[op] = cmp[op] || jb.rx.Observable.fromEvent(cmp.base, op.slice(2))
		       	  	.takeUntil( cmp.destroyed )));

		if (options.jbEmitter || events.length > 0) this.createjbEmitter = true;
		if (options.ctxForPick) this.ctxForPick=options.ctxForPick;
		if (options.extendCtx) this.extendCtxFuncs.push(options.extendCtx);
		if (options.extendCtxOnce) this.extendCtxOnceFuncs.push(options.extendCtxOnce);
		if (options.extendItem)
			this.extendItemFuncs.push(options.extendItem);
		this.styleCtx = this.styleCtx || options.styleCtx;
		this.toolbar = this.toolbar || options.toolbar;
		this.noUpdates = this.noUpdates || options.noUpdates;

	   	if (options.css)
    		this.cssSelectors = (this.cssSelectors || [])
    			.concat(options.css.split(/}\s*/m)
    				.map(x=>x.trim())
    				.filter(x=>x)
    				.map(x=>x+'}')
    				.map(x=>x.replace(/^!/,' '))
    			);

		(options.featuresOptions || []).forEach(f =>
			this.jbExtend(f, context))
		return this;
	}
}

function injectLifeCycleMethods(Comp,jbComp) {
	if (jbComp.jbCheckFuncs.length)
	  Comp.prototype.componentWillUpdate = function() {
		jbComp.jbCheckFuncs.forEach(f=>
			f(this));
//		this.refreshModel && this.refreshModel();
//		this.jbEmitter && this.jbEmitter.next('check');
	}
	if (jbComp.createjbEmitter)
	  Comp.prototype.componentDidUpdate = function() {
		this.jbEmitter.next('after-update');
	}
	if (jbComp.noUpdates)
		Comp.prototype.shouldComponentUpdate = _ => false;
}

ui.garbageCollectCtxDictionary = function(force) {
	var now = new Date().getTime();
	ui.ctxDictionaryLastCleanUp = ui.ctxDictionaryLastCleanUp || now;
	var timeSinceLastCleanUp = now - ui.ctxDictionaryLastCleanUp;
	if (!force && timeSinceLastCleanUp < 10000)
		return;
	ui.ctxDictionaryLastCleanUp = now;

	var used = Array.from(document.querySelectorAll('[jb-ctx]')).map(e=>Number(e.getAttribute('jb-ctx'))).sort((x,y)=>x-y);
	var dict = Object.getOwnPropertyNames(jb.ctxDictionary).map(x=>Number(x)).sort((x,y)=>x-y);
	var lastUsedIndex = 0;
	for(var i=0;i<dict.length;i++) {
		while (used[lastUsedIndex] < dict[i])
			lastUsedIndex++;
		if (used[lastUsedIndex] != dict[i])
			delete jb.ctxDictionary[''+dict[i]];
	}
}

ui.focus = function(elem,logTxt,srcCtx) {
	if (!elem) debugger;
	// block the preview from stealing the studio focus
	var now = new Date().getTime();
	var lastStudioActivity = jb.studio.lastStudioActivity || jb.path(jb,['studio','studioWindow','jb','studio','lastStudioActivity']);
    if (jb.studio.previewjb == jb && lastStudioActivity && now - lastStudioActivity < 1000)
    	return;
    jb.delay(1).then(_=> {
   	    jb.logPerformance('focus',logTxt,elem,srcCtx);
    	elem.focus()
    })
}

ui.wrapWithLauchingElement = (f,context,elem) =>
	ctx2 => {
		if (!elem) debugger;
		return f(context.extendVars(ctx2).setVars({ $launchingElement: { el : elem }}));
	}


// ****************** generic utils ***************

if (typeof $ != 'undefined' && $.fn)
    $.fn.findIncludeSelf = function(selector) {
    	return this.find(selector).addBack(selector); }

jb.jstypes.renderable = value => {
  if (value == null) return '';
  if (Array.isArray(value))
  	return ui.h('div',{},value.map(item=>jb.jstypes.renderable(item)));
  value = jb.val(value,true);
  if (typeof(value) == 'undefined') return '';
  if (value.reactComp)
  	return ui.h(value.reactComp())
  else if (value.constructor && value.constructor.name == 'VNode')
  	return value;
  return '' + value;
}

ui.renderable = ctrl =>
	ctrl && ctrl.reactComp();

// prevent garbadge collection and preserve the ctx as long as it is in the dom
ui.preserveCtx = ctx => {
  jb.ctxDictionary[ctx.id] = ctx;
  return ctx.id;
}

ui.renderWidget = function(profile,elem) {
	var previewElem;
	if (window.parent != window && window.parent.jb)
		window.parent.jb.studio.initPreview(window,[Object.getPrototypeOf({}),Object.getPrototypeOf([])]);
	class R extends jb.ui.Component {
		constructor(props) {
			super();
			this.state.profile = profile;
			if (jb.studio.studioWindow) {
				var st = jb.studio.studioWindow.jb.studio;
				st.refreshPreviewWidget = _ => {
					jb.resources = jb.ui.originalResources || jb.resources;
					previewElem = ui.render(ui.h(R),elem,previewElem);
				}
				st.pageChange.debounceTime(500)
					.filter(page=>page != this.state.profile.$)
					.subscribe(page=>
						this.setState({profile: {$: page}}));
				st.scriptChange.debounceTime(500).subscribe(_=>
						this.setState(null));
			}
		}
		render(pros,state) {
			if (!jb.comps[state.profile.$]) return '';
			return ui.h(new jb.jbCtx().run(state.profile).reactComp())
		}
	}
	previewElem = ui.render(ui.h(R),elem);
}

ui.applyAfter = function(promise,ctx) {
	// should refresh all after promise
}

ui.waitFor = function(check,times,interval) {
  if (check())
    return Promise.resolve(1);

  times = times || 300;
  interval = interval || 50;

  return new Promise((resolve,fail)=>{
    function wait_and_check(counter) {
      if (counter < 1)
        return fail();
      setTimeout(() => {
      	var v = check();
        if (v)
          resolve(v);
        else
          wait_and_check(counter-1)
      }, interval);
    }
    return wait_and_check(times);
  })
}

ui.limitStringLength = function(str,maxLength) {
  if (typeof str == 'string' && str.length > maxLength-3)
    return str.substring(0,maxLength) + '...';
  return str;
}
// ****************** vdom utils ***************

ui.stateChangeEm = new jb.rx.Subject();

ui.setState = function(cmp,state,opEvent,watchedAt) {
	jb.logPerformance('setState',cmp.ctx,state);
	if (state == null && cmp.refresh)
		cmp.refresh();
	else
		cmp.setState(state || {});
	ui.stateChangeEm.next({cmp: cmp, opEvent: opEvent, watchedAt: watchedAt });
}

ui.addClassToVdom = function(vdom,clz) {
	vdom.attributes = vdom.attributes || {};
	vdom.attributes.class = [vdom.attributes.class,clz].filter(x=>x).join(' ');
	return vdom;
}

ui.toggleClassInVdom = function(vdom,clz,add) {
  vdom.attributes = vdom.attributes || {};
  var classes = (vdom.attributes.class || '').split(' ').map(x=>x.trim()).filter(x=>x);
  if (add && classes.indexOf(clz) == -1)
    vdom.attributes.class = classes.concat([clz]).join(' ');
  if (!add)
    vdom.attributes.class = classes.filter(x=>x==clz).join(' ');
  return vdom;
}

ui.item = function(cmp,vdom,data) {
	cmp.jbComp.extendItemFuncs.forEach(f=>f(cmp,vdom,data));
	return vdom;
}

ui.watchRef = function(ctx,cmp,ref,includeChildren) {
    ref && ui.refObservable(ref,cmp,{includeChildren: includeChildren, throw: true})
			.catch(e=>{ return []}) // jb.logException(e,'watch ref',cmp,ref);
			.subscribe(e=>{
        if (ctx && ctx.profile && ctx.profile.$trace)
          console.log('ref change watched: ' + (ref && ref.$jb_path && ref.$jb_path.join('~')),e,cmp,ref,ctx);
        return ui.setState(cmp,null,e,ctx);
      })
}

ui.toVdomOrStr = val => {
	var res = jb.val((Array.isArray(val) && val.length == 1) ? val[0] : val);
	if (typeof res == 'boolean')
		res = '' + res;
  if (res && res.slice)
    res = res.slice(0,100);
	return res;
}

ui.refreshComp = (ctx,el) => {
	var nextElem = el.nextElementSibling;
	var newElem = ui.render(ui.h(ctx.runItself().reactComp()),el.parentElement,el);
	if (nextElem)
		newElem.parentElement.insertBefore(newElem,nextElem);
}

ui.outerWidth  = el => {
  var style = getComputedStyle(el);
  return el.offsetWidth + parseInt(style.marginLeft) + parseInt(style.marginRight);
}
ui.outerHeight = el => {
  var style = getComputedStyle(el);
  return el.offsetHeight + parseInt(style.marginTop) + parseInt(style.marginBottom);
}
ui.offset = el => {
  var rect = el.getBoundingClientRect();
  return {
    top: rect.top + document.body.scrollTop,
    left: rect.left + document.body.scrollLeft
  }
}
ui.parents = el => {
  var res = [];
  el = el.parentNode;
  while(el) {
    res.push(el);
    el = el.parentNode;
  }
  return res;
}
ui.closest = (el,query) => {
  while(el) {
    if (ui.matches(el,query)) return el;
    el = el.parentNode;
  }
}
ui.find = (el,query) => typeof el == 'string' ? Array.from(document.querySelectorAll(el)) : Array.from(el.querySelectorAll(query))
ui.findIncludeSelf = (el,query) => (ui.matches(el,query) ? [el] : []).concat(Array.from(el.querySelectorAll(query)))
ui.addClass = (el,clz) => el.classList.add(clz);
ui.removeClass = (el,clz) => el.classList.remove(clz);
ui.hasClass = (el,clz) => el.classList.contains(clz);
ui.matches = (el,query) => el && el.matches && el.matches(query)
ui.index = el => Array.from(el.parentNode.children).indexOf(el)
ui.inDocument = el => el && (ui.parents(el).slice(-1)[0]||{}).nodeType == 9
ui.addHTML = (el,html) => {
  var elem = document.createElement('div');
  elem.innerHTML = html;
  el.appendChild(elem.firstChild)
}
// ****************** components ****************

jb.component('custom-style', {
	typePattern: /.*-style/, category: 'advanced:10,all:10',
	params: [
		{ id: 'template', as: 'single', essential: true, dynamic: true, ignore: true },
		{ id: 'css', as: 'string' },
    	{ id: 'features', type: 'feature[]', dynamic: true },
	],
	impl: (context,css,features) => ({
		template: context.profile.template,
		css: css,
		featuresOptions: features(),
		styleCtx: context._parent
	})
})

jb.component('style-by-control', {
	typePattern: /.*-style/,category: 'advanced:10,all:20',
	params: [
		{ id: 'control', type: 'control', essential: true, dynamic: true },
		{ id: 'modelVar', as: 'string', essential: true }
	],
	impl: (ctx,control,modelVar) =>
		control(ctx.setVars( jb.obj(modelVar,ctx.vars.$model)))
})

})()
;

(function() {

class ImmutableWithPath {
  constructor(resources) {
    this.resources = resources;
    this.resourceVersions = {};
    this.pathId = 0;
    this.allowedTypes = [Object.getPrototypeOf({}),Object.getPrototypeOf([])];
    this.resourceChange = new jb.rx.Subject();
    jb.delay(1).then(_=>jb.ui.originalResources = jb.resources)
  }
  val(ref) {
    if (ref == null) return ref;
    if (ref.$jb_val) return ref.$jb_val();
    if (!ref.$jb_path) return ref;
    if (ref.handler != this)
      return ref.handler.val(ref)

    var resource = ref.$jb_path[0];
    if (ref.$jb_resourceV == this.resourceVersions[resource])
      return ref.$jb_cache;
    this.refresh(ref);
    if (ref.$jb_invalid)
      return null;
    return ref.$jb_cache = ref.$jb_path.reduce((o,p)=>o[p],this.resources());
  }
  writeValue(ref,value,srcCtx) {
    if (!ref)
      return jb.logError('writeValue: null ref');
    if (this.val(ref) === value) return;
    jb.logPerformance('writeValue',value,ref,srcCtx);
    if (ref.$jb_val)
      return ref.$jb_val(value);
    return this.doOp(ref,{$set: value},srcCtx)
  }
  splice(ref,args,srcCtx) {
    return this.doOp(ref,{$splice: args },srcCtx)
  }
  move(fromRef,toRef,srcCtx) {
    var sameArray = fromRef.$jb_path.slice(0,-1).join('~') == toRef.$jb_path.slice(0,-1).join('~');
    var fromIndex = Number(fromRef.$jb_path.slice(-1));
    var toIndex = Number(toRef.$jb_path.slice(-1));
    var fromArray = this.refOfPath(fromRef.$jb_path.slice(0,-1)),toArray = this.refOfPath(toRef.$jb_path.slice(0,-1));
    if (isNaN(fromIndex) || isNaN(toIndex))
        return jb.logError('move: not array element',fromRef,toRef);

    var valToMove = jb.val(fromRef);
    if (sameArray) {
        if (fromIndex < toIndex) toIndex--; // the deletion changes the index
        return this.doOp(fromArray,{$splice: [[fromIndex,1],[toIndex,0,valToMove]] },srcCtx)
    }
    var events = [
        this.doOp(fromArray,{$splice: [[fromIndex,1]] },srcCtx,true),
        this.doOp(toArray,{$splice: [[toIndex,0,valToMove]] },srcCtx,true),
    ]
    events.forEach(opEvent=>{
        this.refresh(opEvent.ref,opEvent);
        opEvent.newVal = this.val(opEvent.ref);
        this.resourceChange.next(opEvent)
    })
  }
  push(ref,value,srcCtx) {
    return this.doOp(ref,{$push: value},srcCtx)
  }
  merge(ref,value,srcCtx) {
    return this.doOp(ref,{$merge: value},srcCtx)
  }
  doOp(ref,opOnRef,srcCtx,doNotNotify) {
    if (!this.isRef(ref))
      ref = this.asRef(ref);
    if (!ref) return;
    var oldRef = Object.assign({},ref);

    if (!this.refresh(ref)) return;
    if (ref.$jb_path.length == 0)
      return jb.logError('doOp: ref not found');

    var op = {}, resource = ref.$jb_path[0], oldResources = this.resources();
    var deleteOp = typeof opOnRef.$set == 'object' && opOnRef.$set == null;
    jb.path(op,ref.$jb_path,opOnRef); // create op as nested object
    this.markPath(ref.$jb_path);
    var opEvent = {op: opOnRef, path: ref.$jb_path, ref: ref, srcCtx: srcCtx, oldVal: jb.val(ref),
        oldRef: oldRef, resourceVersionsBefore: this.resourceVersions, timeStamp: new Date().getTime()};
    this.resources(jb.ui.update(this.resources(),op),opEvent);
    this.resourceVersions = Object.assign({},jb.obj(resource,this.resourceVersions[resource] ? this.resourceVersions[resource]+1 : 1));
    this.restoreArrayIds(oldResources,this.resources(),ref.$jb_path); // 'update' removes $jb_id from the arrays at the path.
    opEvent.resourceVersionsAfter = this.resourceVersions;
    if (opOnRef.$push)
      opEvent.insertedPath = opEvent.path.concat([opEvent.oldVal.length]);
    if (deleteOp) {
      if (ref.$jb_path.length == 1) // deleting a resource - remove from versions and return
        return delete this.resourceVersions[resource];
      try {
        var parent = ref.$jb_path.slice(0,-1).reduce((o,p)=>o[p],this.resources());
        if (parent)
          delete parent[ref.$jb_path.slice(-1)[0]]
      } catch(e) {
        jb.logException('delete',e);
      }
    }
    if (!doNotNotify) {
        this.refresh(ref,opEvent);
        opEvent.newVal = this.val(ref);
        this.resourceChange.next(opEvent);
    }
    return opEvent;
  }
  restoreArrayIds(from,to,path) {
    if (from && to && from.$jb_id && Array.isArray(from) && Array.isArray(to) && !to.$jb_id && typeof to == 'object')
      to.$jb_id = from.$jb_id;
    if (path.length > 0)
      this.restoreArrayIds(from[path[0]], to[path[0]], path.slice(1))
  }
  asRef(obj,hint) {
    if (!obj) return obj;
    if (obj && (obj.$jb_path || obj.$jb_val))
        return obj;

    var path;
    if (hint && hint.resource) {
      var res = this.pathOfObject(obj,this.resources()[hint.resource]);
      path = res && [hint.resource].concat(res);
    }
    path = path || this.pathOfObject(obj,this.resources()); // try without the hint

    if (path)
      return {
        $jb_path: path,
        $jb_resourceV: this.resourceVersions[path[0]],
        $jb_cache: path.reduce((o,p)=>o[p],this.resources()),
        handler: this,
      }
    return obj;
  }
  isRef(ref) {
    return ref && (ref.$jb_path || ref.$jb_val);
  }
  objectProperty(obj,prop) {
    if (!obj)
      return jb.logError('objectProperty: null obj');
    var objRef = this.asRef(obj);
    if (objRef && objRef.$jb_path) {
      return {
        $jb_path: objRef.$jb_path.concat([prop]),
        $jb_resourceV: objRef.$jb_resourceV,
        $jb_cache: objRef.$jb_cache[prop],
        $jb_parentOfPrim: objRef.$jb_cache,
        handler: this,
      }
    } else {
      return obj[prop]; // not reffable
    }
  }
  refresh(ref,lastOpEvent,silent) {
    if (!ref) debugger;
    try {
      var path = ref.$jb_path, new_ref = {};
      if (!path)
        return !silent && jb.logError('refresh: empty path');
      var currentVersion = this.resourceVersions[path[0]] || 0;
      if (path.length == 1) return true;
      if (currentVersion == ref.$jb_resourceV) return true;
      if (currentVersion == ref.$jb_resourceV + 1 && lastOpEvent && typeof lastOpEvent.op.$set != 'undefined') {
        var res = this.refOfPath(ref.$jb_path,silent); // recalc ref by path
        if (res)
          return Object.assign(ref,res)
        ref.$jb_invalid = true;
        return !silent && jb.logError('refresh: parent not found: '+ path.join('~'));
      }

      if (ref.$jb_parentOfPrim) {
        var parent = this.asRef(ref.$jb_parentOfPrim,{resource: path[0]});
        if (!parent || !this.isRef(parent)) {
          this.asRef(ref.$jb_parentOfPrim,{resource: path[0]}); // for debug
          ref.$jb_invalid = true;
          return !silent && jb.logError('refresh: parent not found: '+ path.join('~'));
        }
        var prop = path.slice(-1)[0];
        new_ref = {
          $jb_path: parent.$jb_path.concat([prop]),
          $jb_resourceV: this.resourceVersions[path[0]],
          $jb_cache: parent.$jb_cache && parent.$jb_cache[prop],
          $jb_parentOfPrim: parent.$jb_path.reduce((o,p)=>o[p],this.resources()),
          handler: this,
        }
      } else {
        var object_path_found = ref.$jb_cache && this.pathOfObject(ref.$jb_cache,this.resources()[path[0]]);
        if (!object_path_found) {
          this.pathOfObject(ref.$jb_cache,this.resources()[path[0]]);
          ref.$jb_invalid = true;
          return !silent && jb.logError('refresh: object not found: ' + path.join('~'));
        }
        var new_path = [path[0]].concat(object_path_found);
        if (new_path) new_ref = {
          $jb_path: new_path,
          $jb_resourceV: this.resourceVersions[new_path[0]],
          $jb_cache: new_path.reduce((o,p)=>o[p],this.resources()),
          handler: this,
        }
      }
      Object.assign(ref,new_ref);
    } catch (e) {
       ref.$jb_invalid = true;
       return !silent && jb.logException(e,'ref refresh ',ref);
    }
    return true;
  }
  refOfPath(path,silent) {
      try {
        var val = path.reduce((o,p)=>o[p],this.resources());
        if (val == null || typeof val != 'object' || Array.isArray(val))
          var parent = path.slice(0,-1).reduce((o,p)=>o[p],this.resources());
        else
          var parent = null

        return {
            $jb_path: path,
            $jb_resourceV: this.resourceVersions[path[0]],
            $jb_cache: val,
            $jb_parentOfPrim: parent,
            handler: this,
          }
      } catch (e) {
        if (!silent)
          jb.logException(e,'ref from path ' + path);
      }
  }
  markPath(path) {
    var leaf = path.reduce((o,p)=>{
      o.$jb_id = o.$jb_id || (++this.pathId);
      return o[p]
    }, this.resources());
    if (leaf && typeof leaf == 'object')
      leaf.$jb_id = leaf.$jb_id || (++this.pathId);
  }
  pathOfObject(obj,lookIn,depth) {
    if (!obj || !lookIn || typeof lookIn != 'object' || typeof obj != 'object' || lookIn.$jb_path || lookIn.$jb_val || depth > 50)
      return;
    if (this.allowedTypes.indexOf(Object.getPrototypeOf(lookIn)) == -1)
      return;

    if (lookIn === obj || (lookIn.$jb_id && lookIn.$jb_id == obj.$jb_id))
      return [];
    for(var p in lookIn) {
      var res = this.pathOfObject(obj,lookIn[p],(depth||0)+1);
      if (res)
        return [p].concat(res);
    }
  }
  // valid(ref) {
  //   return ref.$jb_path && ref.$jb_path.filter(x=>!x).length == 0;
  // }
  refObservable(ref,cmp,settings) {
    if (ref && ref.$jb_observable)
      return ref.$jb_observable(cmp);
    if (!ref || !this.isRef(ref))
      return jb.rx.Observable.of();
    if (ref.$jb_path) {
      return this.resourceChange
        .takeUntil(cmp.destroyed)
        .filter(e=>
            e.ref.$jb_path[0] == ref.$jb_path[0])
        .filter(e=> {
          this.refresh(ref,e,true);
          if (settings && settings.throw && ref.$jb_invalid)
            throw 'invalid ref';
          var path = e.ref.$jb_path;
          var changeInParent = (ref.$jb_path||[]).join('~').indexOf(path.join('~')) == 0;
          if (settings && settings.includeChildren)
            return changeInParent || path.join('~').indexOf((ref.$jb_path||[]).join('~')) == 0;
          return changeInParent;
        })
        .distinctUntilChanged((e1,e2)=>
          e1.newVal == e2.newVal)
    }
    return jb.rx.Observable.of(jb.val(ref));
  }
}

function resourcesRef(val) {
  if (typeof val == 'undefined')
    return jb.resources;
  else
    jb.resources = val;
}

jb.valueByRefHandler = new ImmutableWithPath(resourcesRef);

jb.ui.refObservable = (ref,cmp,settings) =>
  jb.refHandler(ref).refObservable(ref,cmp,settings);

jb.ui.ImmutableWithPath = ImmutableWithPath;
jb.ui.resourceChange = jb.valueByRefHandler.resourceChange;

jb.ui.pathObservable = (path,handler,cmp) => {
  var ref = handler.refOfPath(path.split('~'));
  return handler.resourceChange
    .takeUntil(cmp.destroyed)
    .filter(e=>
        path.indexOf(e.oldRef.$jb_path.join('~')) == 0)
    .map(e=> {
    handler.refresh(ref,e,true);
    if (!ref.$jb_invalid)
        return ref.$jb_path.join('~')
    })
    .filter(newPath=>newPath != path)
    .take(1)
    .map(newPath=>({newPath: newPath, oldPath: path}))
}


})()
;

jb.component('group', {
  type: 'control', category: 'group:100,common:90',
  params: [
    { id: 'title', as: 'string' , dynamic: true },
    { id: 'style', type: 'group.style', defaultValue: { $: 'layout.vertical' }, essential: true , dynamic: true },
    { id: 'controls', type: 'control[]', essential: true, flattenArray: true, dynamic: true, composite: true },
    { id: 'features', type: 'feature[]', dynamic: true },
  ],
  impl: ctx =>
    jb.ui.ctrl(ctx)
})

jb.component('group.init-group', {
  type: 'feature', category: 'group:0',
  impl: ctx => ({
    init: cmp => {
      cmp.calcCtrls = cmp.calcCtrls || (_ =>
        ctx.vars.$model.controls(cmp.ctx).map(c=>jb.ui.renderable(c)).filter(x=>x))
      if (!cmp.state.ctrls)
        cmp.state.ctrls = cmp.calcCtrls()
      cmp.refresh = cmp.refresh || (_ =>
          cmp.setState({ctrls: cmp.calcCtrls() }))

      if (cmp.ctrlEmitter)
        cmp.ctrlEmitter.subscribe(ctrls=>
              jb.ui.setState(cmp,{ctrls:ctrls.map(c=>jb.ui.renderable(c)).filter(x=>x)},null,ctx))
    }
  })
})

jb.component('dynamic-controls', {
  type: 'control',
  params: [
    { id: 'controlItems', type: 'data', as: 'array', essential: true, dynamic: true },
    { id: 'genericControl', type: 'control', essential: true, dynamic: true },
    { id: 'itemVariable', as: 'string', defaultValue: 'controlItem'}
  ],
  impl: (context,controlItems,genericControl,itemVariable) =>
    controlItems()
      .map(controlItem => jb.tosingle(genericControl(
        new jb.jbCtx(context,{data: controlItem, vars: jb.obj(itemVariable,controlItem)})))
      )
})

jb.component('group.dynamic-titles', {
  type: 'feature', category: 'group:30',
  description: 'dynamic titles for sub controls',
  impl: ctx => ({
    doCheck: cmp =>
      (cmp.state.ctrls || []).forEach(ctrl=>
        ctrl.title = ctrl.jbComp.jb_title ? ctrl.jbComp.jb_title() : '')
  })
})

jb.component('control.first-succeeding', {
  type: 'control', category: 'common:30',
  params: [
    { id: 'title', as: 'string' , dynamic: true },
    { id: 'style', type: 'first-succeeding.style', defaultValue :{$: 'first-succeeding.style' }, essential: true , dynamic: true },
    { id: 'controls', type: 'control[]', essential: true, flattenArray: true, dynamic: true, composite: true },
    { id: 'features', type: 'feature[]', dynamic: true },
  ],
  impl: ctx =>
    jb.ui.ctrl(ctx)
})

jb.component('control-with-condition', {
  type: 'control',
  params: [
    { id: 'condition', type: 'boolean', essential: true, as: 'boolean' },
    { id: 'control', type: 'control', essential: true, dynamic: true },
    { id: 'title', as: 'string' },
  ],
  impl: (ctx,condition,ctrl) =>
    condition && ctrl(ctx)
})
;

jb.component('label', {
    type: 'control', category: 'control:100,common:80',
    params: [
        { id: 'title', as: 'ref', essential: true, defaultValue: 'my label', dynamic: true },
        { id: 'style', type: 'label.style', defaultValue: { $: 'label.span' }, dynamic: true },
        { id: 'features', type: 'feature[]', dynamic: true },
    ],
    impl: ctx =>
        jb.ui.ctrl(ctx)
})

jb.component('label.bind-title', {
  type: 'feature',
  impl: ctx => ({
    init: cmp => {
      var ref = ctx.vars.$model.title(cmp.ctx);
      cmp.state.title = fixTitleVal(ref);
      if (jb.isRef(ref))
        jb.ui.refObservable(ref,cmp,{throw: true})
            .catch(e=> cmp.refresh() || [] )
            .subscribe(e=>jb.ui.setState(cmp,{title: fixTitleVal(ref)},e,ctx));

      cmp.refresh = _ =>
        cmp.setState({title: fixTitleVal(ctx.vars.$model.title(cmp.ctx))})

      function fixTitleVal(titleRef) {
        if (titleRef  == null|| titleRef.$jb_invalid)
            return 'ref error';
        return jb.ui.toVdomOrStr(titleRef);
      }
    }
  })
})

jb.component('label.span', {
    type: 'label.style',
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('span',{},state.title),
        features :{$: 'label.bind-title' }
    }
})

jb.component('label.p', {
    type: 'label.style',
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('p',{},state.title),
        features :{$: 'label.bind-title' }
    }
})


jb.component('label.h1', {
    type: 'label.style',
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('h1',{},state.title),
        features :{$: 'label.bind-title' }
    }
})

jb.component('label.heading', {
    type: 'label.style',
    params: [{ id: 'level', as: 'string', defaultValue: 'h1', options: 'h1,h2,h3,h4,h5'}],
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h(cmp.level,{},state.title),
        features :{$: 'label.bind-title' }
    }
})

jb.component('label.card-title', {
    type: 'label.style',
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('div',{ class: 'mdl-card__title' },
    				h('h2',{ class: 'mdl-card__title-text' },	state.title)),
        features :{$: 'label.bind-title' }
    }
})

jb.component('label.card-supporting-text', {
    type: 'label.style',
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('div',{ class: 'mdl-card__supporting-text' },	state.title),
        features :{$: 'label.bind-title' }
    }
})

jb.component('highlight', {
  params: [
    { id: 'base', as: 'string', dynamic: true },
    { id: 'highlight', as: 'string', dynamic: true },
    { id: 'cssClass', as: 'string', defaultValue: 'mdl-color-text--indigo-A700'},
  ],
  impl: (ctx,base,highlight,cssClass) => {
    var h = highlight(), b = base();
    if (!h || !b) return b;
    var highlight = (b.match(new RegExp(h,'i'))||[])[0]; // case sensitive highlight
    if (!highlight) return b;
    return [
        b.split(highlight)[0],
        jb.ui.h('span',{class: cssClass},highlight),
        b.split(highlight).slice(1).join(highlight)]
  }
})
;

jb.component('image', {
	type: 'control,image', category: 'control:50',
	params: [
		{ id: 'url', as: 'string', essential: true },
		{ id: 'imageWidth', as: 'number' },
		{ id: 'imageHeight', as: 'number' },
		{ id: 'width', as: 'number' },
		{ id: 'height', as: 'number' },
		{ id: 'units', as: 'string', defaultValue : 'px'},
		{ id: 'style', type: 'image.style', dynamic: true, defaultValue: { $: 'image.default' } },
		{ id: 'features', type: 'feature[]', dynamic: true }
	],
	impl: ctx => {
			['imageWidth','imageHeight','width','height'].forEach(prop=>
					ctx.params[prop] = ctx.params[prop] || null);
			return jb.ui.ctrl(ctx, {
				init: cmp =>
					cmp.state.url = ctx.params.url
			})
		}
})

jb.component('image.default', {
	type: 'image.style',
	impl :{$: 'custom-style',
		template: (cmp,state,h) =>
			h('div',{}, h('img', {src: state.url})),

		css: `{ {? width: %$$model/width%%$$model/units%; ?} {? height: %$$model/height%%$$model/units%; ?} }
			>img{ {? width: %$$model/imageWidth%%$$model/units%; ?} {? height: %$$model/imageHeight%%$$model/units%; ?} }`
	}
})
;

jb.type('button.style')

jb.component('button', {
  type: 'control,clickable', category: 'control:100,common:100',
  params: [
    { id: 'title', as: 'ref', essential: true, defaultTValue: 'click me', dynamic: true },
    { id: 'action', type: 'action', essential: true, dynamic: true },
    { id: 'style', type: 'button.style', defaultValue: { $: 'button.mdl-raised' }, dynamic: true },
    { id: 'features', type: 'feature[]', dynamic: true },
  ],
  impl: ctx =>
    jb.ui.ctrl(ctx,{
      beforeInit: cmp => {
        cmp.state.title = jb.val(ctx.params.title());
        cmp.refresh = _ =>
          cmp.setState({title: jb.val(ctx.params.title(cmp.ctx))});

        cmp.clicked = ev => {
          if (ev && ev.ctrlKey && cmp.ctrlAction)
            cmp.ctrlAction()
          else if (ev && ev.altKey && cmp.altAction)
            cmp.altAction()
          else
            cmp.action();
        }
      },
      afterViewInit: cmp =>
          cmp.action = jb.ui.wrapWithLauchingElement(ctx.params.action, ctx, cmp.base)
    })
})

jb.component('ctrl-action', {
  type: 'feature', category: 'button:70',
  description: 'action to perform on control+click',
  params: [
    { id: 'action', type: 'action', essential: true, dynamic: true },
  ],
  impl: (ctx,action) => ({
      afterViewInit: cmp =>
        cmp.ctrlAction = jb.ui.wrapWithLauchingElement(ctx.params.action, ctx, cmp.base)
  })
})

jb.component('alt-action', {
  type: 'feature', category: 'button:70',
  description: 'action to perform on alt+click',
  params: [
    { id: 'action', type: 'action', essential: true, dynamic: true },
  ],
  impl: (ctx,action) => ({
      afterViewInit: cmp =>
        cmp.altAction = jb.ui.wrapWithLauchingElement(ctx.params.action, ctx, cmp.base)
  })
})

jb.component('button-disabled', {
  type: 'feature', category: 'button:70',
  description: 'define condition when button is enabled',
  params: [
    { id: 'enabledCondition', type: 'boolean', essential: true, dynamic: true },
  ],
  impl: (ctx,cond) => ({
      init: cmp =>
        cmp.state.isEnabled = ctx2 => cond(ctx.extendVars(ctx2))
  })
})

jb.component('icon-with-action', {
  type: 'control,clickable', category: 'control:30',
  params: [
		{ id: 'icon', as: 'string', essential: true },
		{ id: 'title', as: 'string' },
		{ id: 'action', type: 'action', essential: true, dynamic: true },
		{ id: 'style', type: 'icon-with-action.style', dynamic: true, defaultValue :{$: 'button.mdl-icon' } },
		{ id: 'features', type: 'feature[]', dynamic: true }
  ],
  impl: ctx =>
    jb.ui.ctrl(ctx, {
			init: cmp=>  {
					cmp.icon = ctx.params.icon;
					cmp.state.title = ctx.params.title;
			},
      afterViewInit: cmp =>
          cmp.clicked = jb.ui.wrapWithLauchingElement(ctx.params.action, ctx, cmp.base)
    })
})
;

jb.ui.field_id_counter = jb.ui.field_id_counter || 0;

jb.component('field.databind', {
  type: 'feature',
  impl: ctx => ({
      beforeInit: cmp => {
        if (!ctx.vars.$model || !ctx.vars.$model.databind)
          return jb.logError('bind-field: No databind in model', ctx.vars.$model, ctx);
        cmp.state.title = ctx.vars.$model.title();
        cmp.state.fieldId = jb.ui.field_id_counter++;
        cmp.state.model = jb.val(ctx.vars.$model.databind);

        cmp.refresh = _ => {
          cmp.setState({model: cmp.jbModel()});
          cmp.refreshMdl && cmp.refreshMdl();
          cmp.extendRefresh && cmp.extendRefresh();
        }

        cmp.jbModel = (val,source) => {
          if (val === undefined)
            return jb.val(ctx.vars.$model.databind);
          else { // write
              jb.writeValue(ctx.vars.$model.databind,val,ctx);
          }
        }

        jb.ui.refObservable(ctx.vars.$model.databind,cmp,{throw: true})
            .catch(e=>cmp.refresh() || [])
            .subscribe(e=>jb.ui.setState(cmp,null,e,ctx))
      }
  })
})

jb.component('field.databind-text', {
  type: 'feature',
  params: [
    { id: 'debounceTime', as: 'number', defaultValue: 0 },
    { id: 'oneWay', type: 'boolean', as: 'boolean'}
  ],
  impl: (ctx,debounceTime,oneWay) => ({
      beforeInit: cmp => {
        if (debounceTime) {
          cmp.debouncer = new jb.rx.Subject();
          cmp.debouncer.takeUntil( cmp.destroyed )
          .distinctUntilChanged()
          .debounceTime(debounceTime)
          .subscribe(val=>cmp.jbModel(val))
        }

        if (!ctx.vars.$model || !ctx.vars.$model.databind)
          return jb.logError('bind-field: No databind in model', ctx.vars.$model, ctx);
        cmp.state.title = ctx.vars.$model.title();
        cmp.state.fieldId = jb.ui.field_id_counter++;
        cmp.state.model = jb.val(ctx.vars.$model.databind);

        cmp.jbModel = (val,source) => {
          if (source == 'keyup') {
            if (cmp.debouncer)
              return cmp.debouncer.next(val);
            return jb.delay(1).then(_=>cmp.jbModel(val)); // make sure the input is inside the value
          }

          if (val === undefined)
            return jb.val(ctx.vars.$model.databind);
          else { // write
              cmp.setState({model: val});
              jb.writeValue(ctx.vars.$model.databind,val,ctx);
          }
        }

        var srcCtx = cmp.ctxForPick || cmp.ctx;
        if (!oneWay) jb.ui.refObservable(ctx.vars.$model.databind,cmp,{ throw: true})
            .filter(e=>!e || !e.srcCtx || e.srcCtx.path != srcCtx.path) // block self refresh
            .catch(e=>cmp.setState({model: null}) || [])
            .subscribe(e=>jb.ui.setState(cmp,{model: cmp.jbModel()},e,ctx))
      }
  })
})

jb.component('field.databind-range', {
  type: 'feature',
  impl: ctx => ({
      beforeInit: cmp => {
        if (!ctx.vars.$model || !ctx.vars.$model.databind)
          return jb.logError('bind-field: No databind in model', ctx.vars.$model, ctx);
        cmp.state.title = ctx.vars.$model.title();
        cmp.state.fieldId = jb.ui.field_id_counter++;
        cmp.state.model = jb.val(ctx.vars.$model.databind);

        cmp.jbModel = (val,source) => {
          if (val === undefined)
            return jb.val(ctx.vars.$model.databind);
          else { // write
              jb.writeValue(ctx.vars.$model.databind,val,ctx);
          }
        }

        var srcCtx = cmp.ctxForPick || cmp.ctx;
        jb.ui.refObservable(ctx.vars.$model.databind,cmp)
            .filter(e=>!e || !e.srcCtx || e.srcCtx.path != srcCtx.path) // block self refresh
            .subscribe(e=>jb.ui.setState(cmp,{model: cmp.jbModel()},e,ctx))
      }
  })
})

// jb.component('field.databind', {
//   type: 'feature',
//   params: [
//     { id: 'noUpdates', as: 'boolean' },
//   ],
//   impl: (ctx,noUpdates) => {
//     if (!ctx.vars.$model || !ctx.vars.$model.databind)
//       jb.logError('bind-field: No databind in model', ctx.vars.$model, ctx);
//     return {
//       noUpdates: noUpdates,
//       beforeInit: function(cmp) {
//         cmp.state.title = ctx.vars.$model.title();
//         cmp.state.fieldId = jb.ui.field_id_counter++;
//         cmp.state.model = jb.val(ctx.vars.$model.databind);

//         var srcCtx = cmp.ctxForPick || cmp.ctx;
//         cmp.jbModel = (val,source) => {
//           if (val === undefined)
//             return jb.val(ctx.vars.$model.databind);
//           else { // write
//             if (cmp.inputEvents && source == 'keyup')
//               cmp.inputEvents.next(val); // used for debounce
//             else if (!ctx.vars.$model.updateOnBlur || source != 'keyup') {
//               jb.writeValue(ctx.vars.$model.databind,val,srcCtx);
//               cmp.setState({model,val});
//             }
//           }
//         }
//         if (!noUpdates) {
//           jb.ui.refObservable(ctx.vars.$model.databind,cmp)
//             .filter(e=>!e || cmp.allowSelfRefresh || !e.srcCtx || e.srcCtx.path != srcCtx.path) // block self refresh
//             .subscribe(e=>jb.ui.setState(cmp,{model:jb.val(ctx.vars.$model.databind)},e,ctx))
//         }
//       }
//   }}
// })

// jb.component('field.debounce-databind', {
//   type: 'feature',
//   description: 'debounce input content writing to databind via keyup',
//   params: [
//     { id: 'debounceTime', as: 'number', defaultValue: 500 },
//   ],
//   impl: (ctx,debounceTime) =>
//     ({
//       init: cmp => {
//           cmp.inputEvents = cmp.inputEvents || new jb.rx.Subject();
//           cmp.inputEvents.takeUntil( cmp.destroyed )
//             .distinctUntilChanged()
//             .debounceTime(debounceTime)
//             .subscribe(val=>
//               jb.writeValue(ctx.vars.$model.databind,val)
//           )
//       },
//     })
// })

jb.component('field.data', {
  type: 'data',
  impl: ctx =>
    ctx.vars.$model.databind
})

jb.component('field.default', {
  type: 'feature',
  params: [
    { id: 'value', type: 'data'},
  ],
  impl: function(context,defaultValue) {
    var data_ref = context.vars.$model.databind;
    if (data_ref && jb.val(data_ref) == null)
      jb.writeValue(data_ref,defaultValue)
  }
})

jb.component('field.subscribe', {
  type: 'feature',
  params: [
    { id: 'action', type: 'action', essential: true, dynamic: true },
    { id: 'includeFirst', type: 'boolean', as: 'boolean'},
  ],
  impl: (context,action,includeFirst) => ({
    init: cmp => {
      var data_ref = context.vars.$model && context.vars.$model.databind;
      if (!data_ref) return;
      var includeFirstEm = includeFirst ? jb.rx.Observable.of(jb.val(data_ref)) : jb.rx.Observable.of();
      jb.ui.refObservable(data_ref,cmp)
            .map(e=>jb.val(e.ref))
            .merge(includeFirstEm)
            .filter(x=>x)
            .subscribe(x=>
              action(context.setData(x)));
    }
  })
})

jb.component('field.toolbar', {
  type: 'feature',
  params: [
    { id: 'toolbar', type: 'control', essential: true, dynamic: true },
  ],
  impl: (context,toolbar) =>
  ({
    toolbar: toolbar().reactComp()
  })
})
;

jb.type('editable-text.style');

jb.component('editable-text', {
  type: 'control', category: 'input:100,common:80',
  params: [
    { id: 'title', as: 'string' , dynamic: true },
    { id: 'databind', as: 'ref', essential: true},
    { id: 'updateOnBlur', as: 'boolean', type: 'boolean' },
    { id: 'style', type: 'editable-text.style', defaultValue: { $: 'editable-text.mdl-input' }, dynamic: true },
    { id: 'features', type: 'feature[]', dynamic: true },
  ],
  impl: ctx =>
    jb.ui.ctrl(ctx)
});

jb.component('editable-text.x-button', {
  type: 'feature',
  impl : ctx =>({
    templateModifier: (vdom,cmp,state) =>
      jb.ui.h('div', {},[vdom].concat(cmp.jbModel() ? [jb.ui.h('button', { class: 'delete', onclick: e => cmp.jbModel(null)} ,'×')]  : []) ),
    css: `>.delete {
          margin-left: -16px;
          float: right;
          cursor: pointer; font: 20px sans-serif;
          border: none; background: transparent; color: #000;
          text-shadow: 0 1px 0 #fff; opacity: .1;
      }
      { display : flex }
      >.delete:hover { opacity: .5 }`
  })
})

jb.component('editable-text.helper-popup', {
  type: 'feature',
  params: [
    { id: 'control', type: 'control', dynamic: true, essential: true },
    { id: 'popupId', as: 'string', essential: true },
    { id: 'popupStyle', type: 'dialog.style', dynamic: true, defaultValue :{$: 'dialog.popup' } },
    { id: 'showHelper', as: 'boolean', dynamic: true, defaultValue :{$notEmpty: '%value%' }, description: 'show/hide helper according to input content' },
    { id: 'onEnter', type: 'action', dynamic: true },
    { id: 'onEsc', type: 'action', dynamic: true },
  ],
  impl : ctx =>({
    onkeyup: true,
    onkeydown: true, // used for arrows
    extendCtx: (ctx,cmp) =>
      ctx.setVars({selectionKeySource: {}}),

    afterViewInit: cmp => {
      var input = jb.ui.findIncludeSelf(cmp.base,'input')[0];
      if (!input) return;

      cmp.openPopup = jb.ui.wrapWithLauchingElement( ctx2 =>
            ctx2.run( {$: 'open-dialog',
              id: ctx.params.popupId,
              style: _ctx => ctx.params.popupStyle(_ctx),
              content: _ctx => ctx.params.control(_ctx),
              features: {$: 'dialog-feature.unique-dialog', id: ctx.params.popupId}
            })
          , cmp.ctx, cmp.base );

      cmp.popup = _ =>
        jb.ui.dialogs.dialogs.filter(d=>d.id == ctx.params.popupId)[0];
      cmp.closePopup = _ =>
        cmp.popup() && cmp.popup().close();

      cmp.ctx.vars.selectionKeySource.input = input;
      var keyup = cmp.ctx.vars.selectionKeySource.keyup = cmp.onkeyup.delay(1); // delay to have input updated
      cmp.ctx.vars.selectionKeySource.keydown = cmp.onkeydown;

      jb.delay(500).then(_=>{
        cmp.onkeydown.filter(e=> e.keyCode == 13 && !ctx.params.showHelper(cmp.ctx.setData(input)) ).subscribe(_=>
          ctx.params.onEnter(cmp.ctx));
        cmp.onkeydown.filter(e=> e.keyCode == 27 ).subscribe(_=>
          ctx.params.onEsc(cmp.ctx));
      })

      keyup.filter(e=> [13,27,37,38,39,40].indexOf(e.keyCode) == -1)
        .subscribe(_=>{
          jb.logPerformance('helper-popup', ''+ctx.params.showHelper(cmp.ctx.setData(input)), ''+input.value );
          if (!ctx.params.showHelper(cmp.ctx.setData(input))) {
            jb.logPerformance('helper-popup', 'close popup' );
            cmp.closePopup();
          } else if (!cmp.popup()) {
            jb.logPerformance('helper-popup', 'open popup' );
            cmp.openPopup(cmp.ctx)
          }
      })

      keyup.filter(e=>e.keyCode == 27) // ESC
          .subscribe(_=>cmp.closePopup())
    },
    destroy: cmp =>
        cmp.closePopup(),
  })
})
;

jb.type('editable-boolean.style');

jb.component('editable-boolean',{
  type: 'control', category: 'input:20',
  params: [
    { id: 'databind', as: 'ref'},
    { id: 'style', type: 'editable-boolean.style', defaultValue: { $: 'editable-boolean.checkbox' }, dynamic: true },
    { id: 'title', as: 'string' , dynamic: true },
    { id: 'textForTrue', as: 'string', defaultValue: 'yes', dynamic: true },
    { id: 'textForFalse', as: 'string', defaultValue: 'no', dynamic: true  },
    { id: 'features', type: 'feature[]', dynamic: true },
  ],
  impl: ctx => jb.ui.ctrl(ctx,{
  		init: cmp => {
        cmp.toggle = () =>
          cmp.jbModel(!cmp.jbModel());

  			cmp.text = () => {
          if (!cmp.jbModel) return '';
          return cmp.jbModel() ? ctx.params.textForTrue(cmp.ctx) : ctx.params.textForFalse(cmp.ctx);
        }
        cmp.extendRefresh = _ =>
          cmp.setState({text: cmp.text()})
          
        cmp.refresh();
  		},
  	})
})

jb.component('editable-boolean.keyboard-support', {
  type: 'feature',
  impl: ctx => ({
      onkeydown: true,
      afterViewInit: cmp => {
        cmp.onkeydown.filter(e=> 
            e.keyCode == 37 || e.keyCode == 39)
          .subscribe(x=> {
            cmp.toggle();
            cmp.refreshMdl && cmp.refreshMdl();
          })
      },
    })
})
;

jb.component('editable-number', {
  type: 'control', category: 'input:30',
  params: [
    { id: 'databind', as: 'ref'},
    { id: 'title', as: 'string' , dynamic: true },
    { id: 'style', type: 'editable-number.style', defaultValue: { $: 'editable-number.input' }, dynamic: true },
    { id: 'symbol', as: 'string', description: 'leave empty to parse symbol from value' },
    { id: 'min', as: 'number', defaultValue: 0 },
    { id: 'max', as: 'number', defaultValue: 100 },
    { id: 'displayString', as: 'string', dynamic: true, defaultValue: '%$Value%%$Symbol%' },
    { id: 'dataString', as: 'string', dynamic: true, defaultValue: '%$Value%%$Symbol%' },
    { id: 'autoScale', as: 'boolean', defaultValue: true, description: 'adjust its scale if at edges' },

    { id: 'step', as: 'number', defaultValue: 1, description: 'used by slider' },
    { id: 'initialPixelsPerUnit', as: 'number', description: 'used by slider' },
    { id: 'features', type: 'feature[]', dynamic: true },
  ],
  impl: ctx => {
      class editableNumber {
        constructor(params) {
          Object.assign(this,params);
          if (this.min == null) this.min = NaN;
          if (this.max == null) this.max = NaN;
        }
        numericPart(dataString) {
          if (!dataString) return NaN;
          var parts = (''+dataString).match(/([^0-9\.\-]*)([0-9\.\-]+)([^0-9\.\-]*)/); // prefix-number-suffix
          if ((!this.symbol) && parts)
            this.symbol = parts[1] || parts[3] || this.symbol;
          return (parts && parts[2]) || '';
        }

        calcDisplayString(number,ctx) {
          if (isNaN(number)) return this.placeholder || '';
          return this.displayString(ctx.setVars({ Value: ''+number, Symbol: this.symbol }));
        }

        calcDataString(number,ctx) {
          if (isNaN(number)) return '';
          return this.dataString(ctx.setVars({ Value: ''+number, Symbol: this.symbol }));
        }
      }
      return jb.ui.ctrl(ctx.setVars({ editableNumber: new editableNumber(ctx.params) })) 
  }
})

jb.component('editable-number.input',{
  type: 'editable-number.style',
  impl :{$: 'custom-style', 
      features :{$: 'field.databind-text' },
      template: (cmp,state,h) => h('input', { 
        value: state.model, 
        onchange: e => cmp.jbModel(e.target.value), 
        onkeyup: e => cmp.jbModel(e.target.value,'keyup')  }),
  }
})


;

jb.component('group.wait', {
  type: 'feature', category: 'group:70',
	description: 'wait for asynch data before showing the control',
  params: [
    { id: 'for', essential: true, dynamic: true },
    { id: 'loadingControl', type: 'control', defaultValue: { $:'label', title: 'loading ...'} , dynamic: true },
    { id: 'error', type: 'control', defaultValue: { $:'label', title: 'error: %$error%', css: '{color: red; font-weight: bold}'} , dynamic: true },
    { id: 'varName', as: 'string' },
  ],
  impl: (context,waitFor,loading,error,varName) => ({
      beforeInit : cmp =>
        cmp.state.ctrls = [loading(context)].map(c=>c.reactComp()),

      afterViewInit: cmp => {
        jb.rx.Observable.from(waitFor()).takeUntil(cmp.destroyed).take(1)
          .catch(e=>
              cmp.setState( { ctrls: [error(context.setVars({error:e}))].map(c=>c.reactComp()) }) )
          .subscribe(data => {
              cmp.ctx = cmp.ctx.setData(data);
              if (varName)
                cmp.ctx = cmp.ctx.setVars(jb.obj(varName,data));
              // strong refresh
              cmp.setState({ctrls: []});
              jb.delay(1).then(
                _=>cmp.refresh())
            })


        // cmp.delayed = cmp.ctrlEmitter.toPromise().then(_=>
        //   cmp.jbEmitter.filter(x=>
        //     x=='after-update').take(1).toPromise());
      },
  })
})

jb.component('watch-ref', {
  type: 'feature', category: 'watch:100',
	description: 'subscribes to data changes to refresh component',
  params: [
    { id: 'ref', essential: true, as: 'ref', description: 'reference to data' },
    { id: 'includeChildren', as: 'boolean', description: 'watch childern change as well' },
  ],
  impl: (ctx,ref,includeChildren) => ({
      init: cmp =>
        jb.ui.watchRef(ctx,cmp,ref,includeChildren)
  })
})

jb.component('watch-observable', {
  type: 'feature', category: 'watch',
	description: 'subscribes to a custom rx.observable to refresh component',
  params: [
    { id: 'toWatch', essential: true },
  ],
  impl: (ctx,toWatch) => ({
      init: cmp => {
        if (!toWatch.subscribe)
          return jb.logError('watch-observable: non obsevable parameter');
        var virtualRef = { $jb_observable: cmp =>
          toWatch
        };
        jb.ui.watchRef(ctx,cmp,virtualRef)
      }
  })
})

jb.component('group.data', {
  type: 'feature', category: 'general:100,watch:80',
  params: [
    { id: 'data', essential: true, dynamic: true, as: 'ref' },
    { id: 'itemVariable', as: 'string', description: 'optional. define data as a local variable' },
    { id: 'watch', as: 'boolean' },
    { id: 'includeChildren', as: 'boolean', description: 'watch childern change as well' },
  ],
  impl: (ctx, data_ref, itemVariable,watch,includeChildren) => ({
      init: cmp => {
        if (watch)
          jb.ui.watchRef(ctx,cmp,data_ref(),includeChildren)
      },
      extendCtxOnce: ctx => {
          var val = data_ref();
          var res = ctx.setData(val);
          if (itemVariable)
            res = res.setVars(jb.obj(itemVariable,val));
          return res;
      },
  })
})

jb.component('id', {
  type: 'feature',
	description: 'adds id to html element',
  params: [
    { id: 'id', essential: true, as: 'string' },
  ],
  impl: (ctx,id) => ({
    templateModifier: (vdom,cmp,state) => {
        vdom.attributes.id = id
        return vdom;
      }
  })
})

jb.component('var', {
  type: 'feature', category: 'general:90',
	description: 'defines a local variable',
  params: [
    { id: 'name', as: 'string', essential: true },
    { id: 'value', dynamic: true, defaultValue: '' },
    { id: 'mutable', as: 'boolean', description: 'E.g., selected item variable' },
  ],
  impl: (context, name, value,mutable) => ({
      destroy: cmp => {
        if (mutable)
          jb.writeValue(jb.valueByRefHandler.refOfPath([name + ':' + cmp.resourceId]),null,context)
      },
      extendCtxOnce: (ctx,cmp) => {
        if (!mutable) {
          return ctx.setVars(jb.obj(name, value(ctx)))
        } else {
          cmp.resourceId = cmp.resourceId || cmp.ctx.id; // use the first ctx id
          var refToResource = jb.valueByRefHandler.refOfPath([name + ':' + cmp.resourceId]);
          //jb.writeValue(refToResource,value(ctx.setData(cmp)),context);
          jb.writeValue(refToResource,value(ctx),context);
          return ctx.setVars(jb.obj(name, refToResource));
        }
      }
  })
})

jb.component('bind-refs', {
  type: 'feature', category: 'watch',
  description: 'automatically updates a mutual variable when other value is changing',
  params: [
    { id: 'watchRef', essential: true, as: 'ref' },
    { id: 'includeChildren', as: 'boolean', description: 'watch childern change as well' },
    { id: 'updateRef', essential: true, as: 'ref' },
    { id: 'value', essential: true, as: 'single', dynamic: true },
  ],
  impl: (ctx,ref,includeChildren,updateRef,value) => ({
      init: cmp =>
        jb.ui.refObservable(ref,cmp,{includeChildren:includeChildren}).subscribe(e=>
          jb.writeValue(updateRef,value(cmp.ctx),ctx))
  })
})

jb.component('calculated-var', {
  type: 'feature', category: 'general:60',
	description: 'defines a local variable that watches other variables with auto recalc',
  params: [
    { id: 'name', as: 'string', essential: true },
    { id: 'value', dynamic: true, defaultValue: '', essential: true },
    { id: 'watchRefs', as: 'array', dynamic: true, essential: true, defaultValue: [], description: 'variable to watch. needs to be in array' },
  ],
  impl: (context, name, value,watchRefs) => ({
      destroy: cmp => {
        jb.writeValue(jb.valueByRefHandler.refOfPath([name + ':' + cmp.resourceId]),null,context)
      },
      extendCtxOnce: (ctx,cmp) => {
          cmp.resourceId = cmp.resourceId || cmp.ctx.id; // use the first ctx id
          var refToResource = jb.valueByRefHandler.refOfPath([name + ':' + cmp.resourceId]);
          jb.writeValue(refToResource,value(cmp.ctx),context);
          (watchRefs(cmp.ctx)||[]).map(x=>jb.asRef(x)).filter(x=>x).forEach(ref=>
            jb.ui.refObservable(ref,cmp,{includeChildren:true}).subscribe(e=>
              jb.writeValue(refToResource,value(cmp.ctx),context))
          )
          return ctx.setVars(jb.obj(name, refToResource));
      }
  })
})

jb.component('features', {
  type: 'feature',
	description: 'list of features',
  params: [
    { id: 'features', type: 'feature[]', flattenArray: true, dynamic: true },
  ],
  impl: (ctx,features) =>
    features()
})


jb.component('feature.init', {
  type: 'feature', category: 'lifecycle',
  params: [
    { id: 'action', type: 'action[]', essential: true, dynamic: true }
  ],
  impl: (ctx,action) => ({ init: cmp =>
      action(cmp.ctx)
  })
})

jb.component('feature.after-load', {
  type: 'feature', category: 'lifecycle',
  params: [
    { id: 'action', type: 'action[]', essential: true, dynamic: true }
  ],
  impl: ctx => ({ afterViewInit: cmp =>
      jb.delay(1).then(_ => ctx.params.action(cmp.ctx))
    })
})

jb.component('feature.if', {
  type: 'feature', category: 'feature:85',
	description: 'adds element to dom by condition. no watch',
  params: [
    { id: 'showCondition', essential: true, dynamic: true },
  ],
  impl: (ctx, condition,watch) => ({
    templateModifier: (vdom,cmp,state) =>
        jb.toboolean(condition()) ? vdom : jb.ui.h('span',{style: {display: 'none'}})
  })
})

jb.component('hidden', {
  type: 'feature', category: 'feature:85',
	description: 'adds display:none to element by condition. no watch',
  params: [
    { id: 'showCondition', type: 'boolean', essential: true, dynamic: true },
  ],
  impl: (ctx,showCondition) => ({
    templateModifier: (vdom,cmp,state) => {
      if (!showCondition(cmp.ctx))
        jb.path(vdom,['attributes','style','display'],'none')
      return vdom;
    }
  })
})

jb.component('conditional-class', {
  type: 'feature',
	description: 'toggle class by condition',
  params: [
    { id: 'cssClass', as: 'string', essential: true, dynamic: true },
    { id: 'condition', type: 'boolean', essential: true, dynamic: true },
  ],
  impl: (ctx,cssClass,cond) => ({
    templateModifier: (vdom,cmp,state) => {
      if (cond())
        jb.ui.addClassToVdom(vdom,cssClass())
    }
  })
})

jb.component('feature.hover-title', {
  type: 'feature',
	description: 'set element title, usually shown by browser on hover',
  params: [
    { id: 'title', as: 'string', dynamic: true },
  ],
  impl: (ctx, title) => ({
    templateModifier: (vdom,cmp,state) => {
      vdom.attributes = vdom.attributes || {};
      vdom.attributes.title = title()
      return vdom;
    }
  })
})

jb.component('feature.keyboard-shortcut', {
  type: 'feature', category: 'events',
	description: 'listen to events at the document level even when the component is not active',
  params: [
    { id: 'key', as: 'string', description: 'e.g. Alt+C' },
    { id: 'action', type: 'action', dynamic: true }
  ],
  impl: (context,key,action) => ({
      afterViewInit: cmp =>
        jb.rx.Observable.fromEvent(cmp.base.ownerDocument, 'keydown')
            .takeUntil( cmp.destroyed )
            .subscribe(event=>{
              var keyStr = key.split('+').slice(1).join('+');
              var keyCode = keyStr.charCodeAt(0);
              if (key == 'Delete') keyCode = 46;

              var helper = (key.match('([A-Za-z]*)+') || ['',''])[1];
              if (helper == 'Ctrl' && !event.ctrlKey) return
              if (helper == 'Alt' && !event.altKey) return
              if (event.keyCode == keyCode || (event.key && event.key == keyStr))
                action();
            })
      })
})

jb.component('feature.onHover', {
  type: 'feature', category: 'events',
  params: [
    { id: 'action', type: 'action[]', essential: true, dynamic: true }
  ],
  impl: (ctx,code) => ({
      onmouseenter: true,
      afterViewInit: cmp=>
        cmp.onmouseenter.debounceTime(500).subscribe(()=>
              jb.ui.wrapWithLauchingElement(ctx.params.action, cmp.ctx, cmp.base)())
  })
})

jb.component('feature.onKey', {
  type: 'feature', category: 'events',
  params: [
    { id: 'code', as: 'number' },
    { id: 'action', type: 'action[]', essential: true, dynamic: true }
  ],
  impl: (ctx,code) => ({
      onkeydown: true,
      afterViewInit: cmp=> {
        cmp.base.setAttribute('tabIndex','0');
        cmp.onkeydown.filter(e=> e.keyCode == code).subscribe(()=>
              jb.ui.wrapWithLauchingElement(ctx.params.action, cmp.ctx, cmp.base)())
      }
  })
})

jb.component('feature.onEnter', {
  type: 'feature', category: 'events',
  params: [
    { id: 'action', type: 'action[]', essential: true, dynamic: true }
  ],
  impl :{$: 'feature.onKey', code: 13, action :{$call: 'action'}}
})

jb.component('feature.onEsc', {
  type: 'feature', category: 'events',
  params: [
    { id: 'action', type: 'action[]', essential: true, dynamic: true }
  ],
  impl :{$: 'feature.onKey', code: 27, action :{$call: 'action'}}
})

jb.component('feature.onDelete', {
  type: 'feature', category: 'events',
  params: [
    { id: 'action', type: 'action[]', essential: true, dynamic: true }
  ],
  impl :{$: 'feature.onKey', code: 46, action :{$call: 'action'}}
})


jb.component('group.auto-focus-on-first-input', {
  type: 'feature',
  impl: ctx => ({
      afterViewInit: cmp => {
          var elem = Array.from(cmp.base.querySelectorAll('input,textarea,select'))
            .filter(e => e.getAttribute('type') != 'checkbox')[0];
          elem && jb.ui.focus(elem,'group.auto-focus-on-first-input',ctx);
        }
  })
})
;

jb.component('css', {
  type: 'feature,dialog-feature',
  params: [
    { id: 'css', essential: true, as: 'string' },
  ],
  impl: (context,css) =>
    ({css:css})
})

jb.component('css.class', {
  type: 'feature,dialog-feature',
  params: [
    { id: 'class', essential: true, as: 'string' },
  ],
  impl: (context,clz) =>
    ({class :clz})
})

jb.component('css.width', {
  type: 'feature,dialog-feature',
  params: [
    { id: 'width', essential: true, as: 'number' },
    { id: 'overflow', as: 'string', options: ',auto,hidden,scroll'},
    { id: 'minMax', as: 'string', options: ',min,max'},
    { id: 'selector', as: 'string' },
],
  impl: (ctx,width,overflow,minMax) =>
    ({css: `${ctx.params.selector} { ${minMax ? minMax +'-':''}width: ${width}px ${overflow ? '; overflow-x:' + overflow + ';' : ''} }`})
})

jb.component('css.height', {
  type: 'feature,dialog-feature',
  params: [
    { id: 'height', essential: true, as: 'number' },
    { id: 'overflow', as: 'string', options: ',auto,hidden,scroll'},
    { id: 'minMax', as: 'string', options: ',min,max'},
    { id: 'selector', as: 'string' },
  ],
  impl: (ctx,height,overflow,minMax) =>
    ({css: `${ctx.params.selector} { ${minMax ? minMax +'-':''}height: ${height}px ${overflow ? '; overflow-y:' + overflow : ''} }`})
})

jb.component('css.opacity', {
  type: 'feature',
  params: [
    { id: 'opacity', essential: true, as: 'number', min:0, max:1, step: 0.1 },
    { id: 'selector', as: 'string' },
  ],
  impl: (ctx,opacity) =>
    ({css: `${ctx.params.selector} { opacity: ${opacity} }`})
})

jb.component('css.padding', {
  type: 'feature,dialog-feature',
  params: [
    { id: 'top', as: 'number' },
    { id: 'left', as: 'number' },
    { id: 'right', as: 'number' },
    { id: 'bottom', as: 'number' },
    { id: 'selector', as: 'string' },
  ],
  impl: (ctx) => {
    var css = ['top','left','right','bottom']
      .filter(x=>ctx.params[x] != null)
      .map(x=> `padding-${x}: ${ctx.params[x]}px`)
      .join('; ');
    return {css: `${ctx.params.selector} {${css}}`};
  }
})

jb.component('css.margin', {
  type: 'feature,dialog-feature',
  params: [
    { id: 'top', as: 'number' },
    { id: 'left', as: 'number' },
    { id: 'right', as: 'number' },
    { id: 'bottom', as: 'number' },
    { id: 'selector', as: 'string' },
  ],
  impl: (ctx) => {
    var css = ['top','left','right','bottom']
      .filter(x=>ctx.params[x] != null)
      .map(x=> `margin-${x}: ${ctx.params[x]}px`)
      .join('; ');
    return {css: `${ctx.params.selector} {${css}}`};
  }
})

jb.component('css.transform-rotate', {
  type: 'feature',
  params: [
    { id: 'angle', as: 'number', defaultValue: 0, from: 0, to: 360 },
    { id: 'selector', as: 'string' },
  ],
  impl: (ctx) => {
    return {css: `${ctx.params.selector} {transform:rotate(${ctx.params.angle}deg)}`};
  }
})

jb.component('css.color', {
  type: 'feature',
  params: [
		{ id: 'color', as: 'string' },
		{ id: 'background', as: 'string' },
    { id: 'selector', as: 'string' },
  ],
  impl: (ctx,color) => {
		var css = ['color','background']
      .filter(x=>ctx.params[x])
      .map(x=> `${x}: ${ctx.params[x]}`)
      .join('; ');
    return css && ({css: `${ctx.params.selector} {${css}}`});
  }
})

jb.component('css.transform-scale', {
  type: 'feature',
  params: [
    { id: 'x', as: 'number', defaultValue: 100 },
    { id: 'y', as: 'number', defaultValue: 100 },
    { id: 'selector', as: 'string' },
  ],
  impl: (ctx) => {
    return {css: `${ctx.params.selector} {transform:scale(${ctx.params.x/100},${ctx.params.y/100})}`};
  }
})

jb.component('css.box-shadow', {
  type: 'feature,dialog-feature',
  params: [
    { id: 'blurRadius', as: 'number', defaultValue: 5 },
    { id: 'spreadRadius', as: 'number', defaultValue: 0 },
    { id: 'shadowColor', as: 'string', defaultValue: '#000000'},
    { id: 'opacity', as: 'number', min: 0, max: 1, defaultValue: 0.75, step: 0.01 },
    { id: 'horizontal', as: 'number', defaultValue: 10},
    { id: 'vertical', as: 'number', defaultValue: 10},
    { id: 'selector', as: 'string' },
  ],
  impl: (context,blurRadius,spreadRadius,shadowColor,opacity,horizontal,vertical,selector) => {
    var color = [parseInt(shadowColor.slice(1,3),16) || 0, parseInt(shadowColor.slice(3,5),16) || 0, parseInt(shadowColor.slice(5,7),16) || 0]
      .join(',');
    return ({css: `${selector} { box-shadow: ${horizontal}px ${vertical}px ${blurRadius}px ${spreadRadius}px rgba(${color},${opacity}) }`})
  }
})

jb.component('css.border', {
  type: 'feature,dialog-feature',
  params: [
    { id: 'width',as: 'number', defaultValue: 1},
    { id: 'side', as: 'string', options: 'top,left,bottom,right' },
    { id: 'style', as: 'string', options: 'solid,dotted,dashed,double,groove,ridge,inset,outset', defaultValue: 'solid'},
    { id: 'color', as: 'string', defaultValue: 'black' },
    { id: 'selector', as: 'string' },
  ],
  impl: (context,width,side,style,color,selector) =>
    ({css: `${selector} { border${side?'-'+side:''}: ${width}px ${style} ${color} }`})
})
;

jb.component('open-dialog', {
	type: 'action',
	params: [
		{ id: 'id', as: 'string' },
		{ id: 'style', type: 'dialog.style', dynamic: true, defaultValue: { $:'dialog.default' } },
		{ id: 'content', type: 'control', dynamic: true, defaultValue :{$: 'group'}, forceDefaultCreation: true },
		{ id: 'menu', type: 'control', dynamic: true },
		{ id: 'title', as: 'renderable', dynamic: true  },
		{ id: 'onOK', type: 'action', dynamic: true },
		{ id: 'modal', type: 'boolean', as: 'boolean' },
		{ id: 'features', type: 'dialog-feature[]', dynamic: true }
	],
	impl: function(context,id) {
		var modal = context.params.modal;
		var dialog = {
			id: id,
      instanceId: context.id,
			modal: modal,
			em: new jb.rx.Subject(),
		};

		var ctx = context.setVars({
			$dialog: dialog
		});
		dialog.comp = jb.ui.ctrl(ctx,{
			beforeInit: cmp => {
				cmp.dialog = dialog;

				cmp.state.title = ctx.params.title(ctx);
				try {
					cmp.state.contentComp = ctx.params.content(cmp.ctx).reactComp();
					cmp.hasMenu = !!ctx.params.menu.profile;
					if (cmp.hasMenu)
						cmp.menuComp = ctx.params.menu(cmp.ctx).reactComp();
				} catch (e) {
					jb.logException(e,'dialog');
				}
				dialog.onOK = ctx2 =>
					context.params.onOK(cmp.ctx.extendVars(ctx2));
				cmp.dialogClose = args =>
					dialog.close(args);
				cmp.recalcTitle = (e,srcCtx) =>
					jb.ui.setState(cmp,{title: ctx.params.title(ctx)},e,srcCtx)
			},
			afterViewInit: cmp => {
				cmp.dialog.el = cmp.base;
				cmp.dialog.el.style.zIndex = 100;
			},
		}).reactComp();

		if (!context.probe)
			jb.ui.dialogs.addDialog(dialog,ctx);
		else
			jb.studio.probeResEl = jb.ui.render(jb.ui.h(dialog.comp), jb.studio.probeEl || document.createElement('div'), jb.studio.probeResEl);

		return dialog;
	}
})

jb.component('dialog.close-containing-popup', {
	type: 'action',
	params: [
		{ id: 'OK', type: 'boolean', as: 'boolean', defaultValue: true}
	],
	impl: (context,OK) =>
		context.vars.$dialog && context.vars.$dialog.close({OK:OK})
})

jb.component('dialog.default', {
	type: 'dialog.style',
	impl :{$: 'custom-style',
		template: (cmp,state,h) => h('div',{ class: 'jb-dialog jb-default-dialog'},[
			h('div',{class: 'dialog-title'},state.title),
			h('button',{class: 'dialog-close', onclick:
				_=> cmp.dialogClose() },'×'),
			h(state.contentComp),
		]),
		features:{$:'dialog-feature.drag-title'}
	}
})

jb.component('dialog.popup', {
  type: 'dialog.style',
  impl :{$: 'custom-style',
		template: (cmp,state,h) => h('div',{ class: 'jb-dialog jb-popup'},[
			h(state.contentComp),
		]),
      features: [
       { $: 'dialog-feature.max-zIndex-on-click' },
       { $: 'dialog-feature.close-when-clicking-outside' },
       { $: 'dialog-feature.css-class-on-launching-element' },
       { $: 'dialog-feature.near-launcher-position' }
      ],
      css: '{ position: absolute; background: white; box-shadow: 2px 2px 3px #d5d5d5; padding: 3px 0; border: 1px solid rgb(213, 213, 213) }'
  }
})


jb.component('dialog-feature.unique-dialog', {
	type: 'dialog-feature',
	params: [
		{ id: 'id', as: 'string' },
		{ id: 'remeberLastLocation', type: 'boolean', as: 'boolean' }
	],
	impl: function(context,id,remeberLastLocation) {
		if (!id) return;
		var dialog = context.vars.$dialog;
		dialog.id = id;
		dialog.em.filter(e=>
			e.type == 'new-dialog')
			.subscribe(e=> {
				if (e.dialog != dialog && e.dialog.id == id )
					dialog.close();
		})
	}
})

jb.component('dialog-feature.keyboard-shortcut', {
  type: 'dialog-feature',
  params: [
    { id: 'shortcut', as: 'string', description: 'Ctrl+C or Alt+V' },
    { id: 'action', type: 'action', dynamic: true },
  ],
  impl: (ctx,key,action) => ({
  	  onkeydown : true,
      afterViewInit: cmp=> {
		var dialog = ctx.vars.$dialog;
		dialog.applyShortcut = e=> {
			var key = ctx.params.shortcut;
			if (!key) return;
			if (key.indexOf('-') > 0)
				key = key.replace(/-/,'+');
            var keyCode = key.split('+').pop().charCodeAt(0);
            if (key == 'Delete') keyCode = 46;
            if (key.match(/\+[Uu]p$/)) keyCode = 38;
            if (key.match(/\+[Dd]own$/)) keyCode = 40;
            if (key.match(/\+Right$/)) keyCode = 39;
            if (key.match(/\+Left$/)) keyCode = 37;

            if (key.match(/^[Cc]trl/) && !e.ctrlKey) return;
            if (key.match(/^[Aa]lt/) && !e.altKey) return;
            if (e.keyCode == keyCode)
                return ctx.params.action();
		};

	    cmp.onkeydown.filter(e=> e.keyCode != 17 && e.keyCode != 18) // ctrl ot alt alone
   	  		.subscribe(e=>
   	  			dialog.applyShortcut(e))

	}})
})

jb.component('dialog-feature.near-launcher-position', {
	type: 'dialog-feature',
	params: [
		{ id: 'offsetLeft', as: 'number', defaultValue: 0 },
		{ id: 'offsetTop', as: 'number' , defaultValue: 0 },
		{ id: 'rightSide', as: 'boolean' },
	],
	impl: function(context,offsetLeft,offsetTop,rightSide) {
		return {
			afterViewInit: function(cmp) {
				offsetLeft = offsetLeft || 0; offsetTop = offsetTop || 0;
				if (!context.vars.$launchingElement)
					return console.log('no launcher for dialog');
				var control = context.vars.$launchingElement.el;
				var pos = jb.ui.offset(control);
				var jbDialog = jb.ui.findIncludeSelf(cmp.base,'.jb-dialog')[0];
				offsetLeft += rightSide ? jb.ui.outerWidth(control) : 0;
				var fixedPosition = fixDialogOverflow(control,jbDialog,offsetLeft,offsetTop);
        jbDialog.style.display = 'block';
        jbDialog.style.left = (fixedPosition ? fixedPosition.left : pos.left + offsetLeft) + 'px';
        jbDialog.style.top = (fixedPosition ? fixedPosition.top : pos.top + jb.ui.outerHeight(control) + offsetTop) + 'px';
			}
		}

		function fixDialogOverflow(control,dialog,offsetLeft,offsetTop) {
			var padding = 2,top,left,control_offset = jb.ui.offset(control), dialog_height = jb.ui.outerHeight(dialog), dialog_width = jb.ui.outerWidth(dialog);
			if (control_offset.top > dialog_height && control_offset.top + dialog_height + padding + (offsetTop||0) > window.innerHeight + window.pageYOffset)
				top = control_offset.top - dialog_height;
			if (control_offset.left > dialog_width && control_offset.left + dialog_width + padding + (offsetLeft||0) > window.innerWidth + window.pageXOffset)
				left = control_offset.left - dialog_width;
			if (top || left)
				return { top: top || control_offset.top , left: left || control_offset.left}
		}
	}
})

jb.component('dialog-feature.onClose', {
	type: 'dialog-feature',
	params: [
		{ id: 'action', type: 'action', dynamic: true}
	],
	impl: (ctx,action) =>
		ctx.vars.$dialog.em
			.filter(e => e.type == 'close')
			.take(1)
			.subscribe(e=>
				action(ctx.setData(e.OK)))
})

jb.component('dialog-feature.close-when-clicking-outside', {
	type: 'dialog-feature',
	params: [
		{ id: 'delay', as: 'number', defaultValue: 100 }
	],
	impl: function(context,delay) {
		var dialog = context.vars.$dialog;
		dialog.isPopup = true;
		jb.delay(10).then(() =>  { // delay - close older before
			var clickoutEm = jb.rx.Observable.fromEvent(document, 'mousedown');
			if (jb.studio.previewWindow)
				clickoutEm = clickoutEm.merge(jb.rx.Observable.fromEvent(
			      				(jb.studio.previewWindow || {}).document, 'mousedown'));

		 	clickoutEm.filter(e => jb.ui.closest(e.target,'.jb-dialog') == null)
   				.takeUntil(dialog.em.filter(e => e.type == 'close'))
   				.take(1).delay(delay).subscribe(()=>
		  			dialog.close())
  		})
	}
})

jb.component('dialog.close-dialog', {
	type: 'action',
	params: [
		{ id: 'id', as: 'string' },
		{ id: 'delay', as: 'number', defaultValue: 200 },
	],
	impl: (ctx,id,delay) =>
		jb.ui.dialogs.dialogs.filter(d=>d.id == id)
  			.forEach(d=>jb.delay(delay).then(d.close()))
})

jb.component('dialog.close-all-popups', {
	type: 'action',
	impl: ctx =>
		jb.ui.dialogs.dialogs.filter(d=>d.isPopup)
  			.forEach(d=>d.close())
})

jb.component('dialog.close-all', {
	type: 'action',
	impl: ctx =>
		jb.ui.dialogs.dialogs.forEach(d=>d.close())
})

jb.component('dialog-feature.auto-focus-on-first-input', {
	type: 'dialog-feature',
	params: [
		{ id: 'selectText', as: 'boolean' }
	],
	impl: (ctx,selectText) => ({
		afterViewInit: cmp => {
			jb.delay(1).then(_=> {
				var elem = ctx.vars.$dialog.el.querySelector('input,textarea,select');
				if (elem)
					jb.ui.focus(elem, 'dialog-feature.auto-focus-on-first-input',ctx);
				if (selectText)
					elem.select();
			})
		}
	})
})

jb.component('dialog-feature.css-class-on-launching-element', {
	type: 'dialog-feature',
	impl: context => ({
		afterViewInit: cmp => {
			var dialog = context.vars.$dialog;
			var control = context.vars.$launchingElement.el;
			jb.ui.addClass(control,'dialog-open');
			dialog.em.filter(e=>
				e.type == 'close')
				.take(1)
				.subscribe(()=>
          jb.ui.removeClass(control,'dialog-open'))
		}
	})
})

jb.component('dialog-feature.max-zIndex-on-click', {
	type: 'dialog-feature',
	params: [
		{ id: 'minZIndex', as: 'number'}
	],
	impl: function(context,minZIndex) {
		var dialog = context.vars.$dialog;

		return ({
			afterViewInit: cmp => {
				setAsMaxZIndex();
				dialog.el.onmousedown = setAsMaxZIndex;
			}
		})

		function setAsMaxZIndex() {
			var maxIndex = jb.ui.dialogs.dialogs.reduce(function(max,d) {
				return Math.max(max,(d.el && parseInt(d.el.style.zIndex || 100)+1))
			}, minZIndex || 100)
			dialog.el.style.zIndex = maxIndex;
		}
	}
})

jb.component('dialog-feature.drag-title', {
	type: 'dialog-feature',
	params: [
		{ id: 'id', as: 'string' }
	],
	impl: function(context, id) {
		var dialog = context.vars.$dialog;
		return {
		       css: '>.dialog-title { cursor: pointer }',
		       afterViewInit: function(cmp) {
		       	  var titleElem = cmp.base.querySelector('.dialog-title');
		       	  cmp.mousedownEm = jb.rx.Observable.fromEvent(titleElem, 'mousedown')
		       	  	.takeUntil( cmp.destroyed );

				  if (id && sessionStorage.getItem(id)) {
						var pos = JSON.parse(sessionStorage.getItem(id));
					    dialog.el.style.top  = pos.top  + 'px';
					    dialog.el.style.left = pos.left + 'px';
				  }

				  var mouseUpEm = jb.rx.Observable.fromEvent(document, 'mouseup').takeUntil( cmp.destroyed );
				  var mouseMoveEm = jb.rx.Observable.fromEvent(document, 'mousemove').takeUntil( cmp.destroyed );

				  if (jb.studio.previewWindow) {
				  	mouseUpEm = mouseUpEm.merge(jb.rx.Observable.fromEvent(jb.studio.previewWindow.document, 'mouseup'))
				  		.takeUntil( cmp.destroyed );
				  	mouseMoveEm = mouseMoveEm.merge(jb.rx.Observable.fromEvent(jb.studio.previewWindow.document, 'mousemove'))
				  		.takeUntil( cmp.destroyed );
				  }

				  var mousedrag = cmp.mousedownEm
				  		.do(e =>
				  			e.preventDefault())
				  		.map(e =>  ({
				          left: e.clientX - dialog.el.getBoundingClientRect().left,
				          top:  e.clientY - dialog.el.getBoundingClientRect().top
				        }))
				      	.flatMap(imageOffset =>
			      			 mouseMoveEm.takeUntil(mouseUpEm)
			      			 .map(pos => ({
						        top:  Math.max(0,pos.clientY - imageOffset.top),
						        left: Math.max(0,pos.clientX - imageOffset.left)
						     }))
				      	);

				  mousedrag.distinctUntilChanged().subscribe(pos => {
			        dialog.el.style.top  = pos.top  + 'px';
			        dialog.el.style.left = pos.left + 'px';
			        if (id) sessionStorage.setItem(id, JSON.stringify(pos))
			      });
			  }
	       }
	}
});

jb.component('dialog.dialog-ok-cancel', {
	type: 'dialog.style',
	params: [
		{ id: 'okLabel', as: 'string', defaultValue: 'OK' },
		{ id: 'cancelLabel', as: 'string', defaultValue: 'Cancel' },
	],
	impl :{$: 'custom-style',
		template: (cmp,state,h) => h('div',{ class: 'jb-dialog jb-default-dialog'},[
			h('div',{class: 'dialog-title'},state.title),
			h('button',{class: 'dialog-close', onclick: _=> cmp.dialogClose() },'×'),
			h(state.contentComp),
			h('div',{class: 'dialog-buttons'},[
				h('button',{class: 'mdl-button mdl-js-button mdl-js-ripple-effect', onclick: _=> cmp.dialogClose({OK: false}) },cmp.cancelLabel),
				h('button',{class: 'mdl-button mdl-js-button mdl-js-ripple-effect', onclick: _=> cmp.dialogClose({OK: true}) },cmp.okLabel),
			]),
		]),
	  css: `>.dialog-buttons { display: flex; justify-content: flex-end; margin: 5px }`,
	}
})

jb.component('dialog-feature.resizer', {
	type: 'dialog-feature',
  params: [
    { id: 'resizeInnerCodemirror', as: 'boolean', description: 'effective only for dialog with a single codemirror element' }
  ],
	impl: (ctx,codeMirror) => ({
					templateModifier: (vdom,cmp,state) => {
            if (vdom && vdom.nodeName != 'div') return vdom;
						vdom.children.push(jb.ui.h('img', {src: '/css/resizer.gif', class: 'resizer'}));
			      return vdom;
			    },
		      css: '>.resizer { cursor: pointer; position: absolute; right: 1px; bottom: 1px }',

		      afterViewInit: function(cmp) {
		       	  var resizerElem = cmp.base.querySelector('.resizer');
		       	  cmp.mousedownEm = jb.rx.Observable.fromEvent(resizerElem, 'mousedown')
		       	  	.takeUntil( cmp.destroyed );

						  var mouseUpEm = jb.rx.Observable.fromEvent(document, 'mouseup').takeUntil( cmp.destroyed );
						  var mouseMoveEm = jb.rx.Observable.fromEvent(document, 'mousemove').takeUntil( cmp.destroyed );

						  if (jb.studio.previewWindow) {
						  	mouseUpEm = mouseUpEm.merge(jb.rx.Observable.fromEvent(jb.studio.previewWindow.document, 'mouseup'))
						  		.takeUntil( cmp.destroyed );
						  	mouseMoveEm = mouseMoveEm.merge(jb.rx.Observable.fromEvent(jb.studio.previewWindow.document, 'mousemove'))
						  		.takeUntil( cmp.destroyed );
						  }

              var codeMirrorElem,codeMirrorSizeDiff;
              if (codeMirror) {
                codeMirrorElem = cmp.base.querySelector('.CodeMirror');
                if (codeMirrorElem)
                  codeMirrorSizeDiff = codeMirrorElem.getBoundingClientRect().top - cmp.base.getBoundingClientRect().top
                    + (cmp.base.getBoundingClientRect().bottom - codeMirrorElem.getBoundingClientRect().bottom);
              }

						  var mousedrag = cmp.mousedownEm
						  		.map(e =>  ({
						          left: cmp.base.getBoundingClientRect().left,
						          top:  cmp.base.getBoundingClientRect().top
						        }))
						      	.flatMap(imageOffset =>
					      			 mouseMoveEm.takeUntil(mouseUpEm)
					      			 .map(pos => ({
								        top:  pos.clientY - imageOffset.top,
								        left: pos.clientX - imageOffset.left
								     }))
						      	);

						  mousedrag.distinctUntilChanged().subscribe(pos => {
					        cmp.base.style.height  = pos.top  + 'px';
					        cmp.base.style.width = pos.left + 'px';
                  if (codeMirrorElem)
                    codeMirrorElem.style.height  = (pos.top - codeMirrorSizeDiff) + 'px';
					      });
					  }
	     })
})


jb.ui.dialogs = {
 	dialogs: [],
	addDialog: function(dialog,context) {
		var self = this;
		dialog.context = context;
		this.dialogs.forEach(d=>
			d.em.next({ type: 'new-dialog', dialog: dialog }));
		this.dialogs.push(dialog);
		if (dialog.modal && !document.querySelector('.modal-overlay'))
			jb.ui.addHTML(document.body,'<div class="modal-overlay"></div>');

		dialog.close = function(args) {
			return Promise.resolve().then(_=>{
				if (dialog.closing) return;
				dialog.closing = true;
				if (dialog.onOK && args && args.OK)
					return dialog.onOK(context)
			}).then( _ => {
				dialog.em.next({type: 'close', OK: args && args.OK});
				dialog.em.complete();

				var index = self.dialogs.indexOf(dialog);
				if (index != -1)
					self.dialogs.splice(index, 1);
				if (dialog.modal && document.querySelector('.modal-overlay'))
					document.body.removeChild(document.querySelector('.modal-overlay'));
				jb.ui.dialogs.remove(dialog);
			})
		},
		dialog.closed = _ =>
			self.dialogs.indexOf(dialog) == -1;

		this.render(dialog);
	},
	closeAll: function() {
		this.dialogs.forEach(d=>
			d.close());
	},
  getOrCreateDialogsElem() {
    if (!document.querySelector('.jb-dialogs'))
      jb.ui.addHTML(document.body,'<div class="jb-dialogs"/>');
    return document.querySelector('.jb-dialogs');
  },
  render(dialog) {
    jb.ui.addHTML(this.getOrCreateDialogsElem(),`<div id="${dialog.instanceId}"/>`);
    var elem = document.querySelector(`.jb-dialogs>[id="${dialog.instanceId}"]`);
    jb.ui.render(jb.ui.h(dialog.comp),elem);
  },
  remove(dialog) {
    var elem = document.querySelector(`.jb-dialogs>[id="${dialog.instanceId}"]`);
    if (!elem) return; // already closed due to asynch request handling and multiple requests to close
    jb.ui.render('', elem, elem.firstElementChild);// react - remove
    // jb.ui.unmountComponent(elem.firstElementChild._component);
    this.getOrCreateDialogsElem().removeChild(elem);
  }
}
;


jb.component('menu.menu', {
	type: 'menu.option',
	params: [
		{ id: 'title', as: 'string', dynamic: true, essential: true },
		{ id: 'options', type: 'menu.option[]', dynamic: true, flattenArray: true, essential: true, defaultValue: [] },
	],
	impl: ctx => ({
		options: ctx.params.options,
		title: ctx.params.title(),
		applyShortcut: function(e) {
			return this.options().reduce((res,o)=> res || (o.applyShortcut && o.applyShortcut(e)),false)
		},
		ctx: ctx
	})
})

jb.component('menu.options-group', {
	type: 'menu.option',
	params: [
		{ id: 'options', type: 'menu.option[]', dynamic: true, flattenArray: true, essential: true },
	],
	impl: (ctx,options) =>
    	options()
})

jb.component('menu.dynamic-options', {
  type: 'menu.option',
  params: [
    { id: 'items', type: 'data', as: 'array', essential: true, dynamic: true },
    { id: 'genericOption', type: 'menu.option', essential: true, dynamic: true },
  ],
  impl: (ctx,items,generic) =>
    items().map(item =>
      	generic(ctx.setVars({menuData: item}).setData(item)))
})

jb.component('menu.end-with-separator', {
  type: 'menu.option',
  params: [
    { id: 'options', type: 'menu.option[]', dynamic: true, flattenArray: true, essential: true },
    { id: 'separator', type: 'menu.option', as: 'array', defaultValue :{$: 'menu.separator' } },
    { id: 'title', as: 'string' }
  ],
  impl: (ctx) => {
  	var options = ctx.params.options();
  	if (options.length > 0)
  		return options.concat(ctx.params.separator)
  	return []
  }
})


jb.component('menu.separator', {
	type: 'menu.option',
	impl: ctx => ({ separator: true })
})

jb.component('menu.action', {
	type: 'menu.option',
	params: [
		{ id: 'title', as: 'string', dynamic: true, essential: true },
		{ id: 'action', type: 'action', dynamic: true, essential: true },
		{ id: 'icon', as: 'string' },
		{ id: 'shortcut', as: 'string' },
		{ id: 'showCondition', type:'boolean', as: 'boolean', defaultValue: true }
	],
	impl: ctx =>
		ctx.params.showCondition ? ({
			leaf : ctx.params,
			action: _ => ctx.params.action(ctx.setVars({topMenu:null})), // clean topMenu from context after the action
			title: ctx.params.title(ctx),
			applyShortcut: e=> {
				var key = ctx.params.shortcut;
				if (!key) return;
				if (key.indexOf('-') > 0)
					key = key.replace(/-/,'+');
	            var keyCode = key.split('+').pop().charCodeAt(0);
	            if (key == 'Delete') keyCode = 46;
	            if (key.match(/\+[Uu]p$/)) keyCode = 38;
	            if (key.match(/\+[Dd]own$/)) keyCode = 40;
	            if (key.match(/\+Right$/)) keyCode = 39;
	            if (key.match(/\+Left$/)) keyCode = 37;

	            if (key.match(/^[Cc]trl/) && !e.ctrlKey) return;
	            if (key.match(/^[Aa]lt/) && !e.altKey) return;
	            if (e.keyCode == keyCode) {
	            		e.stopPropagation();
	                ctx.params.action();
									return true;
	            }
			},
			ctx: ctx
		}) : null
})

// ********* actions / controls ************

jb.component('menu.control', {
  type: 'control,clickable,menu',
  params: [
  	{id: 'menu', type: 'menu.option', dynamic: true, essential: true },
    {id: 'style', type: 'menu.style', defaultValue :{$: 'menu-style.context-menu' }, dynamic: true },
		{id: 'features', type: 'feature[]', dynamic: true },
  ],
  impl: ctx => {
  	var menuModel = ctx.params.menu() || { options: [], ctx: ctx, title: ''};
  	return jb.ui.ctrl(ctx.setVars({
  		topMenu: ctx.vars.topMenu || { popups: []},
  		menuModel: menuModel,
  	}),{ctxForPick: menuModel.ctx })
  }
})

jb.component('menu.open-context-menu', {
  type: 'action',
  params: [
  	{id: 'menu', type: 'menu.option', dynamic: true, essential: true },
  	{id: 'popupStyle', type: 'dialog.style', dynamic: true, defaultValue :{$: 'dialog.context-menu-popup'}  },
	{ id: 'features', type: 'dialog-feature[]', dynamic: true }
  ],
  impl :{$: 'open-dialog',
  	  style :{$call: 'popupStyle' },
      content :{$: 'menu.control' , menu :{$call: 'menu'}, style :{$: 'menu-style.context-menu'} },
  	  features :{$call: 'features' },
  }
})

// ********* styles ************

jb.component('menu-style.pulldown', {
	type: 'menu.style',
	params: [
	    { id: 'innerMenuStyle', type: 'menu.style', dynamic: true, defaultValue: {$: 'menu-style.popup-as-option'}},
	    { id: 'leafOptionStyle', type: 'menu-option.style', dynamic: true, defaultValue: {$: 'menu-style.option-line'}},
	    { id: 'layout', type: 'group.style', dynamic: true, defaultValue :{$: 'itemlist.horizontal'}},
	],
  	impl :{$: 'style-by-control', __innerImplementation: true,
    	control :{$: 'itemlist',
	    	$vars: {
	    		optionsParentId: ctx => ctx.id,
	    		innerMenuStyle: ctx => ctx.componentContext.params.innerMenuStyle,
	    		leafOptionStyle: ctx => ctx.componentContext.params.leafOptionStyle,
	    	},
	    	watchItems: false,
	    	style :{$call: 'layout' },
    		items: '%$menuModel/options%',
			controls :{$: 'menu.control', menu: '%$item%', style :{$: 'menu-style.popup-thumb'} },
    		features :{$: 'menu.selection'},
		}
	}
})

jb.component('menu-style.context-menu', {
	type: 'menu.style',
	params: [
	    { id: 'leafOptionStyle', type: 'menu-option.style', dynamic: true, defaultValue: {$: 'menu-style.option-line'}},
	],
  	impl :{$: 'style-by-control', __innerImplementation: true,
    	control :{$: 'itemlist',
			$vars: {
				optionsParentId: ctx => ctx.id,
        leafOptionStyle: ctx => ctx.componentContext.params.leafOptionStyle,
			},
	    	watchItems: false,
    		items: '%$menuModel/options%',
        controls :{$: 'menu.control', menu: '%$item%', style :{$: 'menu-style.apply-multi-level'} },
    		features :{$: 'menu.selection', autoSelectFirst: true},
		}
	}
})


jb.component('menu.init-popup-menu', {
	type: 'feature',
	params: [
	    { id: 'popupStyle', type: 'dialog.style', dynamic: true, defaultValue :{$: 'dialog.context-menu-popup' } },
	],
  	impl: ctx =>
  	({
  		destroy: cmp =>
  			cmp.closePopup()
  		,
 		afterViewInit: cmp => {
 			cmp.setState({title: ctx.vars.menuModel.title});

			cmp.mouseEnter = _ => {
				if (jb.ui.find('.context-menu-popup')[0])
					cmp.openPopup()
			};
			cmp.openPopup = jb.ui.wrapWithLauchingElement( ctx2 => {
	 			cmp.ctx.vars.topMenu.popups.push(ctx.vars.menuModel);
	        	ctx2.run( {$: 'menu.open-context-menu',
	        		popupStyle: _ctx => ctx.params.popupStyle(_ctx),
	        		menu: _ctx =>
	        			ctx.vars.$model.menu()
	        	})
	        } , cmp.ctx, cmp.base );

			cmp.closePopup = _ => {
	  			jb.ui.dialogs.dialogs
	  				.filter(d=>d.id == ctx.vars.optionsParentId)
	  				.forEach(d=>d.close());
	  			cmp.ctx.vars.topMenu.popups.pop();
			};

      jb.delay(1).then(_=>{ // wait for topMenu keydown initalization
  			if (ctx.vars.topMenu && ctx.vars.topMenu.keydown) {
  				var keydown = ctx.vars.topMenu.keydown.takeUntil( cmp.destroyed );

  			    keydown.filter(e=>e.keyCode == 39) // right arrow
  		    	    .subscribe(x=>{
  		        		if (ctx.vars.topMenu.selected == ctx.vars.menuModel && cmp.openPopup)
  		        			cmp.openPopup();
  		        	})
  			    keydown.filter(e=>e.keyCode == 37) // left arrow
  		    	    .subscribe(x=>{
  		        		if (cmp.ctx.vars.topMenu.popups.slice(-1)[0] == ctx.vars.menuModel) {
  		        			ctx.vars.topMenu.selected = ctx.vars.menuModel;
  		        			cmp.closePopup();
  		        		}
  		        	})
          }
      })
		}
  	})
})

jb.component('menu.init-menu-option', {
	type: 'feature',
  	impl: ctx =>
  	({
 		afterViewInit: cmp => {
			var leafParams = ctx.vars.menuModel.leaf;
	        cmp.setState({title:  leafParams.title() ,icon : leafParams.icon ,shortcut: leafParams.shortcut});
	        cmp.action = jb.ui.wrapWithLauchingElement( _ => {
				jb.ui.dialogs.dialogs.filter(d=>d.isPopup)
		  			.forEach(d=>d.close());
		  		jb.delay(50).then(_=>
	        		jb.ui.applyAfter(ctx.vars.menuModel.action(),ctx))
	        }, ctx, cmp.base);

	  		jb.delay(1).then(_=>{ // wait for topMenu keydown initalization
				if (ctx.vars.topMenu && ctx.vars.topMenu.keydown) {
					var keydown = ctx.vars.topMenu.keydown.takeUntil( cmp.destroyed );
				    keydown.filter(e=>e.keyCode == 13 && ctx.vars.topMenu.selected == ctx.vars.menuModel) // Enter
			    	    .subscribe(_=>
			    	    	cmp.action())
			    }
			})
		}
  	})
})

jb.component('menu-style.apply-multi-level', {
	type: 'menu.style',
	params: [
	    { id: 'menuStyle', type: 'menu.style', dynamic: true, defaultValue: {$: 'menu-style.popup-as-option'}},
	    { id: 'leafStyle', type: 'menu.style', dynamic: true, defaultValue: {$: 'menu-style.option-line'}},
	    { id: 'separatorStyle', type: 'menu.style', dynamic: true, defaultValue: {$: 'menu-separator.line'}},
	],
  	impl: ctx => {
  		if (ctx.vars.menuModel.leaf)
  			return ctx.vars.leafOptionStyle ? ctx.vars.leafOptionStyle(ctx) : ctx.params.leafStyle();
  		else if (ctx.vars.menuModel.separator)
  			return ctx.params.separatorStyle()
  		else if (ctx.vars.innerMenuStyle)
  			return ctx.vars.innerMenuStyle(ctx)
  		else
  			return ctx.params.menuStyle();
  	}
})

// jb.component('menu.apply-context-menu-shortcuts', {
//   type: 'feature',
//   impl: ctx => ({
//   	 onkeydown: true,
//      afterViewInit: cmp => {
//         cmp.base.setAttribute('tabIndex','0');
//         if (!ctx.vars.topMenu.keydown) {
//   	        ctx.vars.topMenu.keydown = cmp.onkeydown;
//             jb.ui.focus(cmp.base,'menu.keyboard init autoFocus',ctx);
//       	};
//         var keydown = ctx.vars.topMenu.keydown.takeUntil( cmp.destroyed );
//         keydown.subscribe(e=>cmp.ctx.vars.topMenu.applyShortcut(e))
//       }
//     })
// })

jb.component('menu.selection', {
  type: 'feature',
  params: [
    { id: 'autoSelectFirst', type: 'boolean'},
  ],
  impl: ctx => ({
  	 onkeydown: true,
     afterViewInit: cmp => {
        cmp.base.setAttribute('tabIndex','0');
     	// putting the emitter at the top-menu only and listen at all sub menus

     	if (!ctx.vars.topMenu.keydown) {
	        ctx.vars.topMenu.keydown = cmp.onkeydown;
            jb.ui.focus(cmp.base,'menu.keyboard init autoFocus',ctx);
      	};

        var keydown = ctx.vars.topMenu.keydown.takeUntil( cmp.destroyed );

        keydown.filter(e=>
              e.keyCode == 38 || e.keyCode == 40 )
            .map(event => {
              event.stopPropagation();
              var diff = event.keyCode == 40 ? 1 : -1;
              var items = cmp.items.filter(item=>!item.separator);
              var selectedIndex = items.indexOf(ctx.vars.topMenu.selected);
              if (selectedIndex != -1)
              	return items[(selectedIndex + diff + items.length) % items.length];
	        }).subscribe(x=>{
	        	if (x)
	        		cmp.select(x);
	        })
	    keydown.filter(e=>e.keyCode == 27) // close all popups
    	    .subscribe(_=>{
		  			jb.ui.dialogs.dialogs
		  				.filter(d=>d.isPopup)
		  				.forEach(d=>d.close())
		  			cmp.ctx.vars.topMenu.popups = [];
		  			cmp.ctx.run({$:'tree.regain-focus'});
	    	})
	    cmp.select = item => {
	    	if (ctx.vars.topMenu.selected != item)
	    		cmp.setState({selected: ctx.vars.topMenu.selected = item})
	    }
	    cmp.selected = _ =>
	    	ctx.vars.topMenu.selected;

        if (ctx.params.autoSelectFirst && cmp.items[0])
            cmp.select(cmp.items[0]);
      },
	  extendItem: (cmp,vdom,data) => {
	      jb.ui.toggleClassInVdom(vdom,'selected', ctx.vars.topMenu.selected == data);
	      vdom.attributes.onmouseenter = _ =>
	      	cmp.select(data)
	  },
	  css: '>.selected { background: #bbb !important; color: #fff !important }',
    })
})

jb.component('menu-style.option-line', {
	type: 'menu-option.style',
  	impl :{$: 'custom-style',
		template: (cmp,state,h) => h('div',{
				class: 'line noselect', onmousedown: _ => cmp.action && cmp.action()
			},[
				h('i',{class:'material-icons'},state.icon),
				h('span',{class:'title'},state.title),
				h('span',{class:'shortcut'},state.shortcut),
		]),
		css: `{ display: flex; cursor: pointer; font: 13px Arial; height: 24px}
			  .selected { background: #d8d8d8 }
			  >i { width: 24px; padding-left: 3px; padding-top: 3px; font-size:16px; }
			  >span { padding-top: 3px }
	          >.title { display: block; text-align: left; white-space: nowrap; }
			  >.shortcut { margin-left: auto; text-align: right; padding-right: 15px }`,
        features: [
        	{$: 'mdl.ripple-effect'},
    		{$: 'menu.init-menu-option'}
        ]
	}
})

jb.component('menu.option-as-icon24', {
	type: 'menu-option.style',
  	impl :{$: 'custom-style',
		template: (cmp,state,h) => h('div',{
				class: 'line noselect', onclick: _ => cmp.clicked(), title: state.title
			},[
				h('i',{class:'material-icons'},state.icon),
		]),
		css: `{ display: flex; cursor: pointer; height: 24px}
			  >i { width: 24px; padding-left: 3px; padding-top: 3px; font-size:16px; }`
	}
})

jb.component('menu-style.popup-as-option', {
	type: 'menu.style',
  	impl :{$: 'custom-style',
		template: (cmp,state,h) => h('div',{
				class: 'line noselect', onmousedown: _ => cmp.action()
			},[
				h('span',{class:'title'},state.title),
				h('i',{class:'material-icons', onmouseenter: e => cmp.openPopup(e) },'play_arrow'),
		]),
		css: `{ display: flex; cursor: pointer; font: 13px Arial; height: 24px}
			  >i { width: 100%; text-align: right; font-size:16px; padding-right: 3px; padding-top: 3px; }
	          >.title { display: block; text-align: left; padding-top: 3px; padding-left: 26px; white-space: nowrap; }
			`,
        features :{$: 'menu.init-popup-menu', popupStyle :{$: 'dialog.context-menu-popup', rightSide: true, offsetTop: -24 } },
    }
})

jb.component('menu-style.popup-thumb', {
	type: 'menu.style',
	description: 'used for pulldown',
	impl :{$: 'custom-style',
		template: (cmp,state,h) => h('div',{
				class: 'pulldown-top-menu-item',
				onmouseenter: _ =>
					cmp.mouseEnter(),
				onclick: _ => cmp.openPopup()
		},state.title),
        features :[
          {$: 'menu.init-popup-menu' },
          {$: 'mdl.ripple-effect'}
        ],
	}
})


jb.component('menu-style.toolbar', {
	type: 'menu.style',
	impl :{$: 'menu.multi-level',
		leafOptionStyle :{$: 'menu.option-as-icon24' }
	}
})

jb.component('dialog.context-menu-popup',{
	type: 'dialog.style',
	params: [
		{ id: 'offsetTop', as: 'number' },
		{ id: 'rightSide', as: 'boolean' },
	],
	impl :{$: 'custom-style',
		template: (cmp,state,h) => h('div',{ class: 'jb-dialog jb-popup context-menu-popup pulldown-mainmenu-popup'},
				h(state.contentComp)),
			features: [
				{ $: 'dialog-feature.unique-dialog', id: '%$optionsParentId%', remeberLastLocation: false },
				{ $: 'dialog-feature.max-zIndex-on-click' },
				{ $: 'dialog-feature.close-when-clicking-outside' },
				{ $: 'dialog-feature.css-class-on-launching-element' },
				{ $: 'dialog-feature.near-launcher-position', rightSide: '%$rightSide%', offsetTop: '%$offsetTop%' }
			]
	}
})

jb.component('menu-separator.line', {
	type: 'menu-separator.style',
  	impl :{$: 'custom-style',
      template: (cmp,state,h) => h('div'),
      css: '{ margin: 6px 0; border-bottom: 1px solid #EBEBEB;}'
  }
})
;

jb.component('itemlist', {
  type: 'control', category: 'group:80,common:80',
  params: [
    { id: 'title', as: 'string' },
    { id: 'items', as: 'ref', whenNotReffable: 'array' , dynamic: true, essential: true },
    { id: 'controls', type: 'control[]', essential: true, dynamic: true },
    { id: 'style', type: 'itemlist.style', dynamic: true , defaultValue: { $: 'itemlist.ul-li' } },
    { id: 'watchItems', as: 'boolean' },
    { id: 'itemVariable', as: 'string', defaultValue: 'item' },
    { id: 'features', type: 'feature[]', dynamic: true, flattenArray: true },
  ],
  impl: ctx =>
    jb.ui.ctrl(ctx)
})

jb.component('itemlist.no-container', {
  type: 'feature', category: 'group:20',
  impl: ctx => ({
    extendCtxOnce: (ctx,cmp) =>
      ctx.setVars({itemlistCntr: null})
    })
})

jb.component('itemlist.init', {
  type: 'feature',
  impl: ctx => ({
      beforeInit: cmp => {
        cmp.refresh = _ =>
            cmp.setState({ctrls: cmp.calcCtrls()})

        if (ctx.vars.$model.watchItems && ctx.vars.$model.items)
          jb.ui.watchRef(ctx,cmp,ctx.vars.$model.items(cmp.ctx))

        cmp.calcCtrls = _ => {
            var _items = ctx.vars.$model.items ? jb.toarray(jb.val(ctx.vars.$model.items(cmp.ctx))) : [];
            if (jb.compareArrays(_items,cmp.items))
              return cmp.state.ctrls;
            if (cmp.ctx.vars.itemlistCntr)
              cmp.ctx.vars.itemlistCntr.items = _items;
            cmp.items = _items;
            return _items.slice(0,100).map(item=>
              Object.assign(controlsOfItem(item),{item:item})).filter(x=>x.length > 0);
        }

        function controlsOfItem(item) {
          return ctx.vars.$model.controls(cmp.ctx.setData(item).setVars(jb.obj(ctx.vars.$model.itemVariable,item)))
            .filter(x=>x).map(c=>jb.ui.renderable(c)).filter(x=>x);
        }
      },
      init: cmp => {
        cmp.state.ctrls = cmp.calcCtrls();
      },
  })
})

jb.component('itemlist.ul-li', {
  type: 'itemlist.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('ul',{ class: 'jb-itemlist'},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h('li',
          {class: 'jb-item', 'jb-ctx': jb.ui.preserveCtx(ctrl[0] && ctrl[0].ctx)} ,
          ctrl.map(singleCtrl=>h(singleCtrl))),ctrl.item))),
    css: `{ list-style: none; padding: 0; margin: 0;}
    >li { list-style: none; padding: 0; margin: 0;}`,
    features:{$: 'itemlist.init'},
  },
})

jb.component('itemlist.horizontal', {
  type: 'itemlist.style',
  params: [,
    { id: 'spacing', as: 'number', defaultValue: 0 }
  ],
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{ class: 'jb-drag-parent'},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h('div', {class: 'jb-item', 'jb-ctx': jb.ui.preserveCtx(ctrl[0] && ctrl[0].ctx)} ,
          ctrl.map(singleCtrl=>h(singleCtrl))),ctrl.item))),

    css: `{display: flex}
        >* { margin-right: %$spacing%px }
        >*:last-child { margin-right:0 }`,
    features:{$: 'itemlist.init'},
  }
})

// ****************** Selection ******************

jb.component('itemlist.selection', {
  type: 'feature',
  params: [
    { id: 'databind', as: 'ref', defaultValue: '%$itemlistCntrData/selected%' },
    { id: 'selectedToDatabind', dynamic: true ,defaultValue: '%%' },
    { id: 'databindToSelected', dynamic: true ,defaultValue: '%%' },
    { id: 'onSelection', type: 'action', dynamic: true },
    { id: 'onDoubleClick', type: 'action', dynamic: true },
    { id: 'autoSelectFirst', type: 'boolean'},
    { id: 'cssForSelected', as: 'string', defaultValue: 'background: #bbb !important; color: #fff !important' },
  ],
  impl: ctx => ({
    onclick: true,
    afterViewInit: cmp => {
        cmp.selectionEmitter = new jb.rx.Subject();
        cmp.clickEmitter = new jb.rx.Subject();

        cmp.selectionEmitter
          .merge(cmp.clickEmitter)
          .distinctUntilChanged()
          .filter(x=>x)
          .subscribe( selected => {
              writeSelectedToDatabind(selected);
              cmp.setState({selected: selected});
              ctx.params.onSelection(cmp.ctx.setData(selected));
          });

        jb.ui.refObservable(ctx.params.databind,cmp,{throw: true})
          .catch(e=>jb.ui.setState(cmp,{selected: null }) || [])
          .subscribe(e=>
            jb.ui.setState(cmp,{selected: selectedOfDatabind() },e))

        // double click
        var clickEm = cmp.clickEmitter.takeUntil( cmp.destroyed );
        clickEm.buffer(clickEm.debounceTime(250))
          .filter(buff => buff.length === 2)
          .subscribe(buff=>
            ctx.params.onDoubleClick(cmp.ctx.setData(buff[1])));

        cmp.jbEmitter.filter(x=> x =='after-update').startWith(jb.delay(1)).subscribe(x=>{
          if (cmp.state.selected && cmp.items.indexOf(cmp.state.selected) == -1)
            cmp.state.selected = null;
					if (jb.val(ctx.params.databind))
						cmp.setState({selected: selectedOfDatabind()});
          if (!cmp.state.selected)
            autoSelectFirst()
        })

        function autoSelectFirst() {
          if (ctx.params.autoSelectFirst && cmp.items[0] && !jb.val(ctx.params.databind))
              return cmp.selectionEmitter.next(cmp.items[0])
        }
        function writeSelectedToDatabind(selected) {
          return ctx.params.databind && jb.writeValue(ctx.params.databind,ctx.params.selectedToDatabind(ctx.setData(selected)))
        }
        function selectedOfDatabind() {
          return ctx.params.databind && jb.val(ctx.params.databindToSelected(ctx.setData(jb.val(ctx.params.databind))))
        }
        //autoSelectFirst();
    },
    extendItem: (cmp,vdom,data) => {
      jb.ui.toggleClassInVdom(vdom,'selected',cmp.state.selected == data);
      vdom.attributes.onclick = _ =>
        cmp.clickEmitter.next(data)
    },
    css: '>.selected , >*>.selected { ' + ctx.params.cssForSelected + ' }',
    createjbEmitter: true,
  })
})

jb.component('itemlist.keyboard-selection', {
  type: 'feature',
  params: [
    { id: 'onEnter', type: 'action', dynamic: true },
    { id: 'autoFocus', type: 'boolean' }
  ],
  impl: ctx => ({
      afterViewInit: function(cmp) {
        var onkeydown = (cmp.ctx.vars.itemlistCntr && cmp.ctx.vars.itemlistCntr.keydown) || (cmp.ctx.vars.selectionKeySource && cmp.ctx.vars.selectionKeySource.keydown);
        if (!onkeydown) {
          cmp.base.setAttribute('tabIndex','0');
          onkeydown = jb.rx.Observable.fromEvent(cmp.base, 'keydown')

          if (ctx.params.autoFocus)
            jb.ui.focus(cmp.base,'itemlist.keyboard-selection init autoFocus',ctx)
        }
        cmp.onkeydown = onkeydown.takeUntil( cmp.destroyed );

        cmp.onkeydown.filter(e=> e.keyCode == 13 && cmp.state.selected)
          .subscribe(x=>
            ctx.params.onEnter(cmp.ctx.setData(cmp.state.selected)));

        cmp.onkeydown.filter(e=> !e.ctrlKey &&
              (e.keyCode == 38 || e.keyCode == 40))
            .map(event => {
              event.stopPropagation();
              var diff = event.keyCode == 40 ? 1 : -1;
              var items = cmp.items;
              return items[(items.indexOf(cmp.state.selected) + diff + items.length) % items.length] || cmp.state.selected;
        }).subscribe(x=>
          cmp.selectionEmitter && cmp.selectionEmitter.next(x)
        )
      },
    })
})

jb.component('itemlist.drag-and-drop', {
  type: 'feature',
  params: [
  ],
  impl: ctx => ({
      afterViewInit: function(cmp) {
        var drake = dragula([cmp.base.querySelector('.jb-drag-parent') || cmp.base] , {
          moves: (el,source,handle) =>
            jb.ui.hasClass(handle,'drag-handle')
        });

        drake.on('drag', function(el, source) {
          var item = el.getAttribute('jb-ctx') && jb.ctxDictionary[el.getAttribute('jb-ctx')].data;
          if (!item) {
            var item_comp = el._component || (el.firstElementChild && el.firstElementChild._component);
            item = item_comp && item_comp.ctx.data;
          }
          el.dragged = {
            item: item,
            remove: item => cmp.items.splice(cmp.items.indexOf(item), 1)
          }
          cmp.selectionEmitter && cmp.selectionEmitter.next(el.dragged.item);
        });
        drake.on('drop', (dropElm, target, source,sibling) => {
            var draggedIndex = cmp.items.indexOf(dropElm.dragged.item);
            var targetIndex = sibling ? jb.ui.index(sibling) : cmp.items.length;
            jb.splice(cmp.items,[[draggedIndex,1],[targetIndex-1,0,dropElm.dragged.item]],ctx);

            dropElm.dragged = null;
        });

        // ctrl + Up/Down
//        jb.delay(1).then(_=>{ // wait for the keyboard selection to register keydown
          if (!cmp.onkeydown) return;
          cmp.onkeydown.filter(e=>
            e.ctrlKey && (e.keyCode == 38 || e.keyCode == 40))
            .subscribe(e=> {
              var diff = e.keyCode == 40 ? 1 : -1;
              var selectedIndex = cmp.items.indexOf(cmp.state.selected);
              if (selectedIndex == -1) return;
              var index = (selectedIndex + diff+ cmp.items.length) % cmp.items.length;
              jb.splice(cmp.items,[[selectedIndex,1],[index,0,cmp.state.selected]],ctx);
          })
//        })
      }
    })
})

jb.component('itemlist.drag-handle', {
  description: 'put on the control inside the item which is used to drag the whole line',
  type: 'feature',
  impl: {$list: [ {$: 'css.class', class: 'drag-handle' }, {$: 'css', css:'{cursor: pointer}'} ] }
})

jb.component('itemlist.shown-only-on-item-hover', {
  type: 'feature', category: 'itemlist:75',
  description: 'put on the control inside the item which is shown when the mouse enters the line',
  impl: (ctx,cssClass,cond) => ({
    class: 'jb-shown-on-item-hover',
    css: '{ display: none }'
  })
})

jb.component('itemlist.divider', {
  type: 'feature',
  params: [
    { id: 'space', as: 'number', defaultValue: 5}
  ],
  impl : (ctx,space) =>
    ({css: `>.jb-item:not(:first-of-type) { border-top: 1px solid rgba(0,0,0,0.12); padding-top: ${space}px }`})
})
;

(function() {

createItemlistCntr = (ctx,params) => ({
  id: params.id,
  defaultItem: params.defaultItem,
  filter_data: {},
  filters: [],
  selectedRef: ctx.exp('%$itemlistCntrData/selected%','ref'),
  selected: function(selected) {
    return (typeof selected != 'undefined') ?
      jb.writeValue(this.selectedRef,selected,this.ctx) : jb.val(this.selectedRef)
  },
  add: function(item) {
    var newItem = item || JSON.parse(JSON.stringify(this.defaultItem || {}));
    if (this.items) {
      jb.splice(this.items,[[this.items.length,0,newItem]]);
      this.selected(newItem);
    }
  },
  delete: function(item) {
    if (this.items && this.items.indexOf(item) != -1) {
      this.changeSelectionBeforeDelete();
      jb.splice(this.items,[[this.items.indexOf(item),1]]);
    }
  },
  reSelectAfterFilter: function(filteredItems) {
		if (filteredItems.indexOf(this.selected()) == -1)
      this.selected(filteredItems[0])
  },
  changeSelectionBeforeDelete: function() {
    if (this.items && this.selected) {
      var curIndex = this.items.indexOf(this.selected);
      if (curIndex == -1)
        this.selected = null;
      else if (curIndex == 0 && this.items.length > 0)
        this.selected = this.items[1];
      else if (this.items.length > 0)
        this.selected = this.items[curIndex -1];
      else
        this.selected = null;
    }
  }
})

jb.component('group.itemlist-container', {
  description: 'itemlist writable container to support addition, deletion and selection',
  type: 'feature', category: 'itemlist:80,group:70',
  params: [
    { id: 'id', as: 'string' },
    { id: 'defaultItem', as: 'single' },
    { id: 'maxItems', as: 'number' , defaultValue: 100 },
		{ id: 'initialSelection', as: 'single' },
  ],
  impl :{$list : [
    {$: 'var', name: 'itemlistCntrData', value: {$: 'object', search_pattern: '', selected: '%$initialSelection%', maxItems: '%$maxItems%' } , mutable: true},
    {$: 'var', name: 'itemlistCntr', value: ctx => createItemlistCntr(ctx,ctx.componentContext.params) },
    ctx => ({
      init: cmp => {
        var maxItemsRef = cmp.ctx.exp('%$itemlistCntrData/maxItems%','ref');
//        jb.writeValue(maxItemsRef,ctx.componentContext.params.maxItems);
        cmp.ctx.vars.itemlistCntr.maxItemsFilter = items =>
          items.slice(0,jb.tonumber(maxItemsRef));
      },
    })
  ]}
})

jb.component('itemlist.itemlist-selected', {
  type: 'feature',   category: 'itemlist:20,group:0',
  impl :{ $list : [
  			{$: 'group.data', data : '%$itemlistCntrData/selected%'},
  			{$: 'hidden', showCondition: {$notEmpty: '%$itemlistCntrData/selected%' } }
  		]}
})

jb.component('itemlist-container.add', {
  type: 'action',
  impl: ctx =>
  		ctx.vars.itemlistCntr && ctx.vars.itemlistCntr.add()
})

jb.component('itemlist-container.delete', {
  type: 'action',
  params: [{ id: 'item', as: 'single', defaultValue: '%%'} ],
  impl: (ctx,item) =>
      ctx.vars.itemlistCntr && ctx.vars.itemlistCntr.delete(item)
})

jb.component('itemlist-container.filter', {
  type: 'aggregator', category: 'itemlist-filter:100',
  requires: ctx => ctx.vars.itemlistCntr,
  impl: ctx => {
      if (!ctx.vars.itemlistCntr) return;
      jb.writeValue(ctx.exp('%$itemlistCntrData/countBeforeFilter%','ref'),(ctx.data || []).length);
      var res = ctx.vars.itemlistCntr.filters.reduce((items,filter) =>
                  filter(items), ctx.data || []);
      jb.writeValue(ctx.exp('%$itemlistCntrData/countBeforeMaxFilter%','ref'),res.length);
      res = ctx.vars.itemlistCntr.maxItemsFilter(res);
      if (ctx.exp('%$itemlistCntrData/countAfterFilter%','number') != res.length)
        jb.delay(1).then(_=>ctx.vars.itemlistCntr.reSelectAfterFilter(res));
      jb.writeValue(ctx.exp('%$itemlistCntrData/countAfterFilter%','ref'),res.length);
      return res;
   }
})

jb.component('itemlist-container.search', {
  type: 'control', category: 'itemlist-filter:100',
  requires: ctx => ctx.vars.itemlistCntr,
  params: [
    { id: 'title', as: 'string' , dynamic: true, defaultValue: 'Search' },
    { id: 'searchIn', as: 'string' , dynamic: true, defaultValue: {$: 'itemlist-container.search-in-all-properties'} },
    { id: 'databind', as: 'ref', defaultValue: '%$itemlistCntrData/search_pattern%'},
    { id: 'style', type: 'editable-text.style', defaultValue: { $: 'editable-text.mdl-search' }, dynamic: true },
    { id: 'features', type: 'feature[]', dynamic: true },
  ],
  impl: (ctx,title,searchIn,databind) =>
    jb.ui.ctrl(ctx,{
      afterViewInit: cmp => {
        if (ctx.vars.itemlistCntr) {
          ctx.vars.itemlistCntr.filters.push( items => {
            var toSearch = jb.val(databind) || '';
            if (typeof searchIn.profile == 'function') { // improved performance
              return items.filter(item=>toSearch == '' || searchIn.profile(item).toLowerCase().indexOf(toSearch.toLowerCase()) != -1)
            }

            return items.filter(item=>toSearch == '' || searchIn(ctx.setData(item)).toLowerCase().indexOf(toSearch.toLowerCase()) != -1)
          });
        // allow itemlist selection use up/down arrows
        ctx.vars.itemlistCntr.keydown = jb.rx.Observable.fromEvent(cmp.base, 'keydown')
            .takeUntil( cmp.destroyed )
            .filter(e=>  [13,27,37,38,39,40].indexOf(e.keyCode) != -1);
        }
      }
    })
});

jb.component('itemlist-container.more-items-button', {
  type: 'control', category: 'itemlist-filter:100',
  requires: ctx => ctx.vars.itemlistCntr,
  params: [
    { id: 'title', as: 'string' , dynamic: true, defaultValue: 'show %$delta% more ... (%$itemlistCntrData/countAfterFilter%/%$itemlistCntrData/countBeforeMaxFilter%)' },
    { id: 'delta', as: 'number' , defaultValue: 200 },
    { id: 'style', type: 'button.style', defaultValue: { $: 'button.href' }, dynamic: true },
    { id: 'features', type: 'feature[]', dynamic: true },
  ],
  impl: (ctx,title,delta) => {
    return jb.ui.ctrl(ctx,{
      beforeInit: cmp => {
        if (!ctx.vars.itemlistCntr) return;
        var maxItemsRef = cmp.ctx.exp('%$itemlistCntrData/maxItems%','ref');
        cmp.clicked = _ =>
          jb.writeValue(maxItemsRef,jb.tonumber(maxItemsRef) + delta);
        cmp.refresh = _ =>
          cmp.setState({title: jb.val(ctx.params.title(cmp.ctx.setVars({delta: delta})))});
        jb.ui.watchRef(ctx,cmp,maxItemsRef);
      },
      init: cmp =>
        cmp.state.title = jb.val(ctx.params.title(cmp.ctx.setVars({delta: delta}))),

      templateModifier: (vdom,cmp,state) => { // hide the button when not needed
        if (cmp.ctx.exp('%$itemlistCntrData/countBeforeMaxFilter%','number') == cmp.ctx.exp('%$itemlistCntrData/countAfterFilter%','number'))
          return jb.ui.h('span');
        return vdom;
      }
    })
  }
});

jb.ui.extractPropFromExpression = exp => { // performance for simple cases such as %prop1%
  if (exp.match(/^%.*%$/) && !exp.match(/[./[]/))
    return exp.match(/^%(.*)%$/)[1]
}

// match fields in pattern itemlistCntrData/FLDNAME_filter to data
jb.component('itemlist-container.filter-field', {
  type: 'feature', category: 'itemlist-filter:80',
  requires: ctx => ctx.vars.itemlistCntr,
  params: [
    { id: 'fieldData', dynamic: true, essential: true },
    { id: 'filterType', type: 'filter-type' },
  ],
  impl: (ctx,fieldData,filterType) => ({
      afterViewInit: cmp => {
        var propToFilter = jb.ui.extractPropFromExpression(ctx.params.fieldData.profile);
        if (propToFilter)
          cmp.itemToFilterData = item => item[propToFilter];
        else
          cmp.itemToFilterData = item => fieldData(ctx.setData(item));

        ctx.vars.itemlistCntr && ctx.vars.itemlistCntr.filters.push(items=>{
            var filterValue = cmp.jbModel();
            if (!filterValue) return items;
            var res = items.filter(item=>filterType.filter(filterValue,cmp.itemToFilterData(item)) );
            if (filterType.sort)
              filterType.sort(res,cmp.itemToFilterData,filterValue);
            return res;
        })
    }
  })
});

jb.component('filter-type.text', {
  type: 'filter-type',
  params: [
    { id: 'ignoreCase', as: 'boolean', defaultValue: true }
  ],
  impl: (ctx,ignoreCase) => ignoreCase ? ({
    filter: (filter,data) => (data||'').toLowerCase().indexOf((filter||'').toLowerCase()) != -1,
    sort: (items,itemToData,filter) =>  {
      var asWord = new RegExp('\\b' + filter + '\\b','i');
      var score = txt => (asWord.test(txt) ? 5 : 0) + (txt.toLowerCase().indexOf(filter.toLowerCase()) == 0 ? 3 : 0); // higher score for wholeWord or beginsWith
      items.sort((item1,item2)=> score(itemToData(item1) || '') - score(itemToData(item2) || ''))
    }
  }) : ({
    filter: (filter,data) => (data||'').indexOf(filter||'') != -1,
    sort: (items,itemToData,filter) =>  {
      var asWord = new RegExp('\\b' + filter + '\\b');
      var score = txt => (asWord.test(txt) ? 5 : 0) + (txt.indexOf(filter) == 0 ? 3 : 0);
      items.sort((item1,item2)=> score(itemToData(item1) || '') - score(itemToData(item2) || ''))
    }
  })
})

jb.component('filter-type.exact-match', {
  type: 'filter-type',
  impl: ctx => ({
    filter: (filter,data) =>  {
      var _filter = (filter||'').trim(), _data = (data||'').trim();
      return _data.indexOf(_filter) == 0 && _data.length == _filter.length;
    }
  })
})

jb.component('filter-type.numeric', {
  type: 'filter-type',
  impl: ctx => ({
    filter: (filter,data) => Number(data) >= Number(filter),
    sort: (items,itemToData) => items.sort((item1,item2)=> Number(itemToData(item1)) - Number(itemToData(item2)))
  })
})

jb.component('itemlist-container.search-in-all-properties', {
  type: 'data', category: 'itemlist-filter:40',
  impl: ctx => {
    if (typeof ctx.data == 'string') return ctx.data;
    if (typeof ctx.data != 'object') return '';
    return jb.entries(ctx.data).map(e=>e[1]).filter(v=>typeof v == 'string').join('#');
   }
})


})()
;

jb.component('picklist', {
  type: 'control', category: 'input:80',
  params: [
    { id: 'title', as: 'string' , dynamic: true },
    { id: 'databind', as: 'ref'},
    { id: 'options', type: 'picklist.options', dynamic: true, essential: true, defaultValue: {$ : 'picklist.optionsByComma'} },
    { id: 'promote', type: 'picklist.promote', dynamic: true },
    { id: 'style', type: 'picklist.style', defaultValue: { $: 'picklist.native' }, dynamic: true },
    { id: 'features', type: 'feature[]', dynamic: true },
  ],
  impl: ctx =>
    jb.ui.ctrl(ctx,{
      beforeInit: function(cmp) {
        cmp.recalcOptions = function() {
          var options = ctx.params.options(ctx);
          var groupsHash = {};
          var promotedGroups = (ctx.params.promote() || {}).groups || [];
          var groups = [];
          options.filter(x=>x.text).forEach(o=>{
            var groupId = groupOfOpt(o);
            var group = groupsHash[groupId] || { options: [], text: groupId};
            if (!groupsHash[groupId]) {
              groups.push(group);
              groupsHash[groupId] = group;
            }
            group.options.push({text: o.text.split('.').pop(), code: o.code });
          })
          groups.sort((p1,p2)=>promotedGroups.indexOf(p2.text) - promotedGroups.indexOf(p1.text));
          jb.ui.setState(cmp,{
            groups: groups,
            options: options,
            hasEmptyOption: options.filter(x=>!x.text)[0]
          })
        }
        cmp.recalcOptions();
        jb.ui.refObservable(ctx.params.databind,cmp).subscribe(e=>
          cmp.onChange && cmp.onChange(jb.val(e.ref)))
      },
    })
})

function groupOfOpt(opt) {
  if (!opt.group && opt.text.indexOf('.') == -1)
    return '---';
  return opt.group || opt.text.split('.').shift();
}

jb.component('picklist.dynamic-options', {
  type: 'feature',
  params: [
    { id: 'recalcEm', as: 'single'}
  ],
  impl: (ctx,recalcEm) => ({
    init: cmp =>
      recalcEm && recalcEm.subscribe &&
        recalcEm.takeUntil( cmp.destroyed )
        .subscribe(e=>
            cmp.recalcOptions())
  })
})

jb.component('picklist.onChange', {
  type: 'feature',
  description: 'action on picklist selection',
  params: [
    { id: 'action', type: 'action', dynamic: true}
  ],
  impl: (ctx,action) => ({
    init: cmp =>
      cmp.onChange = val => action(ctx.setData(val))
  })
})

// ********* options

jb.component('picklist.optionsByComma',{
  type: 'picklist.options',
  params: [
    { id: 'options', as: 'string', essential: true},
    { id: 'allowEmptyValue', type: 'boolean' },
  ],
  impl: function(context,options,allowEmptyValue) {
    var emptyValue = allowEmptyValue ? [{code:'',value:''}] : [];
    return emptyValue.concat((options||'').split(',').map(code=> ({ code: code, text: code })));
  }
});

jb.component('picklist.options',{
  type: 'picklist.options',
  params: [
    { id: 'options', type: 'data', as: 'array', essential: true},
    { id: 'allowEmptyValue', type: 'boolean' },
  ],
  impl: function(context,options,allowEmptyValue) {
    var emptyValue = allowEmptyValue ? [{code:'',value:''}] : [];
    return emptyValue.concat(options.map(code=> ({ code: code, text: code })));
  }
})

jb.component('picklist.coded-options',{
  type: 'picklist.options',
  params: [
    { id: 'options', as: 'array',essential: true },
    { id: 'code', as: 'string', dynamic:true , essential: true },
    { id: 'text', as: 'string', dynamic:true, essential: true } ,
    { id: 'allowEmptyValue', type: 'boolean' },
  ],
  impl: function(context,options,code,text,allowEmptyValue) {
    var emptyValue = allowEmptyValue ? [{code:'',value:''}] : [];
    return emptyValue.concat(options.map(function(option) {
      return {
        code: code(null,option), text: text(null,option)
      }
    }))
  }
})

jb.component('picklist.sorted-options', {
  type: 'picklist.options',
  params: [
    { id: 'options', type: 'picklist.options', dynamic: true, essential: true, composite: true },
    { id: 'marks', as: 'array', description: 'e.g input:80,group:90. 0 mark means hidden. no mark means 50' },
  ],
  impl: (ctx,optionsFunc,marks) => {
    var options = optionsFunc() || [];
    marks.forEach(mark=> {
        var option = options.filter(opt=>opt.code == mark.code)[0];
        if (option)
          option.mark = Number(mark.mark || 50);
    });
    options = options.filter(op=>op.mark != 0);
    options.sort((o1,o2)=>(o2.mark || 50) - (o1.mark || 50));
    return options;
  }
})

jb.component('picklist.promote',{
  type: 'picklist.promote',
  params: [
    { id: 'groups', as: 'array'},
    { id: 'options', as: 'array'},
  ],
  impl: (context,groups,options) =>
    ({ groups: groups, options: options})
});
;


jb.component('material-icon', {
	type: 'control', category: 'control:50',
	params: [
		{ id: 'icon', as: 'string', essential: true },
		{ id: 'title', as: 'string' },
		{ id: 'style', type: 'icon.style', dynamic: true, defaultValue :{$: 'icon.material' } },
		{ id: 'features', type: 'feature[]', dynamic: true }
	],
	impl: ctx =>
		jb.ui.ctrl(ctx,{init: cmp=> cmp.state.icon = ctx.params.icon})
})

jb.component('icon.icon-in-button', {
    type: 'icon-with-action.style',
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('button',{ class: 'mdl-button mdl-button--icon mdl-js-button mdl-js-ripple-effect', onclick: ev => cmp.clicked(ev) },
		      h('i',{ class: 'material-icons' }, state.icon)),
    }
})

jb.component('icon.material', {
    type: 'icon-with-action.style',
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('i',{ class: 'material-icons' }, state.icon),
    }
})
;

jb.type('theme');

jb.component('group.theme', {
  type: 'feature',
  params: [
    { id: 'theme', type: 'theme' },
  ],
  impl: (context,theme) => ({
    extendCtxOnce: (ctx,cmp) => 
      ctx.setVars(theme)
  })
})

jb.component('theme.material-design', {
  type: 'theme',
  impl: () => ({
  	'$theme.editable-text': 'editable-text.mdl-input'
  })
})
;

jb.component('editable-number.slider-no-text', {
  type: 'editable-number.style',
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('input',{ type: 'range',
        min: state.min, max: state.max, step: state.step,
        value: state.model, mouseup: e => cmp.jbModel(e.target.value), tabindex: -1}),
      features :[
          {$: 'field.databind-range' },
          {$: 'slider.init'},
      ],
  }
})

jb.component('editable-number.slider', {
  type: 'editable-number.style',
  impl :{$: 'style-by-control', __innerImplementation: true,
    modelVar: 'editableNumberModel',
    control :{$: 'group',
      title: '%$editableNumberModel/title%',
      controls :{$: 'group',
        style: {$: 'layout.horizontal', spacing: 20},
        controls: [
          {$: 'editable-text',
              databind: '%$editableNumberModel/databind%',
              style: {$: 'editable-text.mdl-input-no-floating-label', width: 36 },
              features: [
                {$: 'slider-text.handleArrowKeys' },
                { $: 'css.margin', top : -3}
              ],
          },
          {$: 'editable-number',
              databind: '%$editableNumberModel/databind%',
              style :{$: 'editable-number.slider-no-text'},
              features: {$: 'css.width', width: 80},
          },
        ],
        features: {$: 'var', name: 'sliderCtx', value: {$: 'object'}}
      }
    }
  }
})

jb.component('slider.init', {
  type: 'feature',
  impl: ctx => ({
      onkeyup: true,
      onkeydown: true,
      onmouseup: true,
      onmousedown: true,
      onmousemove: true,
      init: cmp =>
        cmp.refresh =  _=> {
          var val = cmp.jbModel() !=null && Number(cmp.jbModel());
          cmp.max = Math.max.apply(0,[ctx.vars.$model.max,val,cmp.max].filter(x=>x!=null));
          cmp.min = Math.min.apply(0,[ctx.vars.$model.min,val,cmp.min].filter(x=>x!=null));
          if (val == cmp.max && ctx.vars.$model.autoScale)
            cmp.max += cmp.max - cmp.min;
          if (val == cmp.min && ctx.vars.$model.autoScale)
            cmp.min -= cmp.max - cmp.min;

          jb.ui.setState(cmp,{ min: cmp.min, max: cmp.max, step: ctx.vars.$model.step, val: cmp.jbModel() },null,ctx);
        },

      afterViewInit: cmp => {
          cmp.refresh();

          cmp.handleArrowKey = e => {
              var val = Number(cmp.jbModel()) || 0;
              if (e.keyCode == 46) // delete
                jb.writeValue(ctx.vars.$model.databind,null);
              if ([37,39].indexOf(e.keyCode) != -1) {
                var inc = e.shiftKey ? 9 : 1;
                if (val !=null && e.keyCode == 39)
                  cmp.jbModel(Math.min(cmp.max,val+inc));
                if (val !=null && e.keyCode == 37)
                  cmp.jbModel(Math.max(cmp.min,val-inc));
              }
          }

          cmp.onkeydown.subscribe(e=>
              cmp.handleArrowKey(e));

          // drag
          cmp.onmousedown.flatMap(e=>
            cmp.onmousemove.takeUntil(cmp.onmouseup)
            ).subscribe(e=>cmp.jbModel(cmp.base.value))

          if (ctx.vars.sliderCtx) // supporting left/right arrow keys in the text field as well
            ctx.vars.sliderCtx.handleArrowKey = e => cmp.handleArrowKey(e);
        }
    })
})

jb.component('slider-text.handleArrowKeys', {
  type: 'feature',
  impl: ctx => ({
      onkeyup: true,
      onkeydown: true,
      afterViewInit: cmp => {
          jb.delay(1).then(_=>{
            var sliderCtx = ctx.vars.sliderCtx;
            if (sliderCtx)
              cmp.onkeydown.subscribe(e=>
                  sliderCtx.handleArrowKey(e));
          })
      }
    })
})

jb.component('slider.edit-as-text-popup', {
  type: 'feature',
  impl :{$: 'open-dialog',
    style :{$: 'dialog.popup' },
    content :{$: 'group',
      title: 'data-settings',
      style :{$: 'layout.vertical', spacing: 3 },
      controls: [
        {$: 'editable-text',
          title: '%title%',
          databind: '%databind%',
          style :{$: 'editable-text.mdl-input', width: '270' },
          features :{$: 'feature.onEnter',
            action :{$: 'dialog.close-containing-popup' }
          },
        },
      ],
      features: [
        {$: 'group.data', data: '%$editableNumber%' },
        {$: 'css.padding', left: '10', right: '10' }
      ]
    },
    features: [
        { $: 'dialog-feature.unique-dialog', id: 'slider', remeberLastLocation: false },
        { $: 'dialog-feature.max-zIndex-on-click' },
        { $: 'dialog-feature.close-when-clicking-outside' },
        { $: 'dialog-feature.css-class-on-launching-element' },
        { $: 'dialog-feature.near-launcher-position' },
        {$: 'dialog-feature.auto-focus-on-first-input', selectText: true },
      ]
  },
})


jb.component('editable-number.mdl-slider', {
  type: 'editable-number.style',
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('input',{class:'mdl-slider mdl-js-slider', type: 'range',
        min: state.min, max: state.max, step: state.step,
        value: state.model, mouseup: e => cmp.jbModel(e.target.value), tabindex: 0}),
      features :[
          {$: 'field.databind' },
          {$: 'slider.init'},
          {$: 'mdl-style.init-dynamic' }
      ],
  }
})
;

jb.component('table', {
  type: 'control', category: 'group:80,common:70',
  params: [
    { id: 'title', as: 'string' },
    { id: 'items', as: 'ref', whenNotReffable: 'array' , dynamic: true, essential: true },
    { id: 'fields', type: 'table-field[]', essential: true, dynamic: true },
    { id: 'style', type: 'table.style', dynamic: true , defaultValue: { $: 'table.with-headers' } },
    { id: 'watchItems', as: 'boolean' },
    { id: 'features', type: 'feature[]', dynamic: true, flattenArray: true },
  ],
  impl: ctx =>
    jb.ui.ctrl(ctx)
})

jb.component('field', {
  type: 'table-field',
  params: [
    { id: 'title', as: 'string', essential: true },
    { id: 'data', as: 'string', essential: true, dynamic: true },
    { id: 'width', as: 'number' },
    { id: 'class', as: 'string' },
  ],
  impl: (ctx,title,data,width,_class) => ({
    title: title,
    fieldData: row => data(ctx.setData(row)),
    class: _class,
    width: width,
    ctxId: jb.ui.preserveCtx(ctx)
  })
})

jb.component('field.control', {
  type: 'table-field',
  params: [
    { id: 'title', as: 'string', essential: true },
    { id: 'control', type: 'control' , dynamic: true, essential: true, defaultValue: {$: 'label', title: ''} },
    { id: 'width', as: 'number' },
  ],
  impl: (ctx,title,control,width) => ({
    title: title,
    control: row => control(ctx.setData(row)).reactComp(),
    width: width,
    ctxId: jb.ui.preserveCtx(ctx)
  })
})

jb.component('table.init', {
  type: 'feature',
  impl: ctx => ({
      beforeInit: cmp => {
        cmp.state.items = calcItems();
        cmp.fields = ctx.vars.$model.fields();

        cmp.refresh = _ =>
            cmp.setState({items: calcItems()})

        if (ctx.vars.$model.watchItems)
          jb.ui.watchRef(ctx,cmp,ctx.vars.$model.items(cmp.ctx))

        function calcItems() {
          cmp.items = jb.toarray(jb.val(ctx.vars.$model.items(cmp.ctx)));
          if (cmp.ctx.vars.itemlistCntr)
              cmp.ctx.vars.itemlistCntr.items = cmp.items;
          return cmp.items.slice(0,100);
        }
      },
  })
})
;

jb.component('tabs', {
	type: 'control', category: 'group:80',
	params: [
		{ id: 'tabs', type: 'control[]', essential: true, flattenArray: true, dynamic: true },
		{ id: 'style', type: 'tabs.style', dynamic: true, defaultValue: { $: 'tabs.simple' } },
		{ id: 'features', type: 'feature[]', dynamic: true },
	],
  impl: ctx =>
    jb.ui.ctrl(ctx)
})

jb.component('group.init-tabs', {
  type: 'feature', category: 'group:0',
  params: [
    { id: 'keyboardSupport', as: 'boolean' },
    { id: 'autoFocus', as: 'boolean' }
  ],
  impl: ctx => ({
    init: cmp => {
			cmp.tabs = ctx.vars.$model.tabs();
      cmp.titles = cmp.tabs.map(tab=>tab.jb_title(ctx));
			cmp.state.shown = 0;

      cmp.show = index =>
        jb.ui.setState(cmp,{shown: index},null,ctx);

      cmp.next = diff =>
        cmp.setState({shown: (cmp.state.index + diff + cmp.ctrls.length) % cmp.ctrls.length});
    },
  })
})

jb.component('tabs.simple', {
  type: 'group.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{}, [
			  h('div',{class: 'tabs-header'}, cmp.titles.map((title,index)=>
					h('button',{class:'mdl-button mdl-js-button mdl-js-ripple-effect' + (index == state.shown ? ' selected-tab': ''),
						onclick: ev=>cmp.show(index)},title))),
				h('div',{class: 'tabs-content'}, h(jb.ui.renderable(cmp.tabs[state.shown]) )) ,
				]),
		css : `>.tabs-header>.selected-tab { border-bottom: 2px solid #66afe9 }
		`,
    features :[{$: 'group.init-tabs'}, {$: 'mdl-style.init-dynamic', query: '.mdl-js-button'}]
  }
})
;

jb.component('mdl-style.init-dynamic', {
  type: 'feature',
  params: [
  	{id: 'query', as: 'string'}
  ],
  impl: (ctx,query) =>
    ({
      afterViewInit: cmp => {
        var elems = query ? cmp.base.querySelectorAll(query) : [cmp.base];
        cmp.refreshMdl = _ => {
          jb.delay(1).then(_ => elems.forEach(el=> {
            if (!jb.ui.inDocument(el))
              return;
            componentHandler.downgradeElements(el);
            componentHandler.upgradeElement(el);
          }))
        };
        jb.delay(1).catch(e=>{}).then(_ =>
      	 elems.forEach(el=>
      	 	jb.ui.inDocument(el) && componentHandler.upgradeElement(el))).catch(e=>{})
      },
      destroy: cmp => {
        try {
      	 $.contains(document.documentElement, cmp.base) &&
          (query ? cmp.base.querySelectorAll(query) : [cmp.base]).forEach(el=>
      	 	   jb.ui.inDocument(el) && componentHandler.downgradeElements(el))
        } catch(e) {}
       }
    })
})

jb.component('mdl.ripple-effect', {
  type: 'feature',
  description: 'add ripple effect to buttons',
  impl: ctx => ({
      templateModifier: (vdom,cmp,state) => {
        vdom.children.push(jb.ui.h('span',{class:'mdl-ripple'}));
        return vdom;
      },
      css: '{ position: relative; overflow:hidden }',
      afterViewInit: cmp => {
          cmp.base.classList.add('mdl-js-ripple-effect');
          jb.ui.inDocument(cmp.base) && componentHandler.upgradeElement(cmp.base);
      },
      destroy: cmp =>
          jb.ui.inDocument(cmp.base) && componentHandler.downgradeElements(cmp.base)
   }),
})


// ****** label styles

jb.component('label.mdl-ripple-effect', {
    type: 'label.style',
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('div',{class:'mdl-button mdl-js-button mdl-js-ripple-effect'},state.title),
        features :[
          {$: 'label.bind-title' },
          {$: 'mdl-style.init-dynamic'}
        ],
    }
});

jb.component('label.mdl-button', {
    type: 'label.style',
    params: [
      {id: 'width', as: 'number' }
    ],
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('div',{class:'mdl-button mdl-js-button'},state.title),
        features :[
          {$: 'label.bind-title' },
          {$: 'mdl-style.init-dynamic'}
        ],
        css: '{? {width:%$width%px} ?}'
    }
});
;

jb.component('goto-url', {
	type: 'action',
	description: 'navigate/open a new web page, change href location',
	params: [
		{ id: 'url', as:'string', essential: true },
		{ id: 'target', type:'enum', values: ['new tab','self'], defaultValue:'new tab', as:'string'}
	],
	impl: (ctx,url,target) => {
		var _target = (target == 'new tab') ? '_blank' : '_self';
		if (!ctx.probe)
			window.open(url,_target);
	}
})
;

jb.component('button.href', {
  type: 'button.style',
    impl :{$: 'custom-style',
        template: (cmp,state,h) => h('a',{href: 'javascript:;', onclick: ev => cmp.clicked(ev)}, state.title),
        css: `{color: grey}`
    }
})

jb.component('button.x', {
  type: 'button.style',
  params: [
    { id: 'size', as: 'number', defaultValue: '21'}
  ],
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('button',{title: state.title, onclick: ev => cmp.clicked(ev)},'×'),
      css: `{
            padding: 0;
            cursor: pointer;
            font: %$size%px sans-serif;
            border: none;
            background: transparent;
            color: #000;
            text-shadow: 0 1px 0 #fff;
            font-weight: 700;
            opacity: .2;
        }
        :hover { opacity: .5 }`
  }
})

jb.component('button.mdl-raised', {
  type: 'button.style',
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('button',{class: 'mdl-button mdl-button--raised mdl-js-button mdl-js-ripple-effect', onclick: ev => cmp.clicked(ev)},state.title),
      features :{$: 'mdl-style.init-dynamic'},
  }
})

jb.component('button.mdl-flat-ripple', {
  type: 'button.style',
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('button',{class:'mdl-button mdl-js-button mdl-js-ripple-effect', onclick: ev=>cmp.clicked(ev)},state.title),
      features :{$: 'mdl-style.init-dynamic'},
      css: '{ text-transform: none }'
  }
})

jb.component('button.mdl-icon', {
  type: 'button.style,icon-with-action.style',
  params: [
    { id: 'icon', as: 'string', default: 'code' },
  ],
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('button',{
          class: 'mdl-button mdl-button--icon mdl-js-button mdl-js-ripple-effect',
          title: state.title, tabIndex: -1,
          onclick:  ev => cmp.clicked(ev) },
        h('i',{class: 'material-icons'},cmp.icon)
      ),
      css: `{ border-radius: 2px}
      >i {border-radius: 2px}`,
      features :{$: 'mdl-style.init-dynamic'},
  }
})

jb.component('button.mdl-round-icon', {
  type: 'button.style,icon-with-action.style',
  params: [
    { id: 'icon', as: 'string', default: 'code' },
  ],
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('button',{
          class: 'mdl-button mdl-button--icon mdl-js-button mdl-js-ripple-effect',
          title: state.title, tabIndex: -1,
          onclick:  ev => cmp.clicked(ev) },
        h('i',{class: 'material-icons'},cmp.icon)
      ),
      features :{$: 'mdl-style.init-dynamic'},
  }
})

jb.component('button.mdl-icon-12-with-ripple', {
  type: 'button.style,icon-with-action.style',
  params: [
    { id: 'icon', as: 'string', default: 'code' },
  ],
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('button',{
          class: 'mdl-button mdl-button--icon mdl-js-button mdl-js-ripple-effect',
          title: state.title, tabIndex: -1,
          onclick: ev => cmp.clicked(ev) },
        h('i',{class: 'material-icons'},cmp.icon)
      ),
      css: `>.material-icons { font-size:12px;  }`,
      features:{$: 'mdl-style.init-dynamic'},
  }
})

jb.component('button.mdl-icon-12', {
  type: 'button.style,icon-with-action.style',
  params: [
    { id: 'icon', as: 'string', default: 'code' },
  ],
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('i',{class: 'material-icons',
        onclick: ev => cmp.clicked(ev)
      },cmp.icon),
      css: `{ font-size:12px; cursor: pointer }`,
  }
})

jb.component('button.mdl-card-flat', {
  type: 'button.style',
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('a',{class:'mdl-button mdl-button--colored mdl-js-button mdl-js-ripple-effect', onclick: ev=>cmp.clicked(ev)},state.title),
      features :{$: 'mdl-style.init-dynamic'},
  }
})
;

jb.component('editable-text.input', {
  type: 'editable-text.style',
  impl :{$: 'custom-style',
      features :{$: 'field.databind-text' },
      template: (cmp,state,h) => h('input', {
        value: state.model,
        onchange: e => cmp.jbModel(e.target.value),
        onkeyup: e => cmp.jbModel(e.target.value,'keyup')  }),
    css: '{height: 16px}'
  }
})

jb.component('editable-text.textarea', {
	type: 'editable-text.style',
  params: [
    { id: 'rows', as: 'number', defaultValue: 4 },
    { id: 'cols', as: 'number', defaultValue: 120 },
  ],
  impl :{$: 'custom-style',
      features :{$: 'field.databind-text' },
      template: (cmp,state,h) => h('textarea', {
        rows: cmp.rows, cols: cmp.cols,
        value: state.model, onchange: e => cmp.jbModel(e.target.value), onkeyup: e => cmp.jbModel(e.target.value,'keyup')  }),
	}
})

jb.component('editable-text.mdl-input', {
  type: 'editable-text.style',
  params: [
    { id: 'width', as: 'number' },
  ],
  impl :{$: 'custom-style',
   template: (cmp,state,h) => h('div',{class:'mdl-textfield mdl-js-textfield mdl-textfield--floating-label' },[
        h('input', { class: 'mdl-textfield__input', id: 'input_' + state.fieldId, type: 'text',
            value: state.model,
            onchange: e => cmp.jbModel(e.target.value),
            onkeyup: e => cmp.jbModel(e.target.value,'keyup'),
        }),
        h('label',{class: 'mdl-textfield__label', for: 'input_' + state.fieldId},state.title)
      ]),
      css: '{ {?width: %$width%px?} }',
      features :[
          {$: 'field.databind-text' },
          {$: 'mdl-style.init-dynamic'}
      ],
  }
})

jb.component('editable-text.mdl-input-no-floating-label', {
  type: 'editable-text.style',
  params: [
    { id: 'width', as: 'number' },
  ],
  impl :{$: 'custom-style',
   template: (cmp,state,h) =>
        h('input', { class: 'mdl-textfield__input', type: 'text',
            value: state.model,
            onchange: e => cmp.jbModel(e.target.value),
            onkeyup: e => cmp.jbModel(e.target.value,'keyup'),
        }),
      css: '{ {?width: %$width%px?} } :focus { border-color: #3F51B5; border-width: 2px}',
      features :[
          {$: 'field.databind-text' },
          {$: 'mdl-style.init-dynamic'}
      ],
  }
})

jb.component('editable-text.mdl-search', {
  type: 'editable-text.style',
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('div',{class:'mdl-textfield mdl-js-textfield'},[
        h('input', { class: 'mdl-textfield__input', id: 'search_' + state.fieldId, type: 'text',
            value: state.model,
            onchange: e => cmp.jbModel(e.target.value),
            onkeyup: e => cmp.jbModel(e.target.value,'keyup'),
        }),
        h('label',{class: 'mdl-textfield__label', for: 'search_' + state.fieldId},state.title)
      ]),
      features: [
          {$: 'field.databind-text' },
          {$: 'mdl-style.init-dynamic'}
      ],
  }
})
;

jb.component('layout.vertical', {
  type: 'group.style',
  params: [
    { id: 'spacing', as: 'number', defaultValue: 3 }
  ],
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h('div', {} ,h(ctrl)), ctrl.ctx.data) )),
    css: `>div { margin-bottom: %$spacing%px; display: block }
          >div:last-child { margin-bottom:0 }`,
    features :{$: 'group.init-group'}
  }
})

jb.component('layout.horizontal', {
  type: 'group.style',
  params: [,
    { id: 'spacing', as: 'number', defaultValue: 3 }
  ],
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h(ctrl),ctrl.ctx.data))),
    css: `{display: flex}
        >* { margin-right: %$spacing%px }
        >*:last-child { margin-right:0 }`,
    features :{$: 'group.init-group'}
  }
})

jb.component('layout.horizontal-fixed-split', {
  type: 'group.style',
  params: [,
    { id: 'leftWidth', as: 'number', defaultValue: 200, essential: true },
    { id: 'rightWidth', as: 'number', defaultValue: 200, essential: true },
    { id: 'spacing', as: 'number', defaultValue: 3 },
  ],
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h(ctrl),ctrl.ctx.data))),
    css: `{display: flex}
        >*:first-child { margin-right: %$spacing%px; flex: 0 0 %$leftWidth%px; width: %$leftWidth%px; }
        >*:last-child { margin-right:0; flex: 0 0 %$rightWidth%px; width: %$rightWidth%px; }`,
    features :{$: 'group.init-group'}
  }
})

jb.component('layout.horizontal-wrapped', {
  type: 'group.style',
  params: [,
    { id: 'spacing', as: 'number', defaultValue: 3 }
  ],
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h('span', {} ,h(ctrl)),ctrl.ctx.data) )),
    css: `{display: flex}
        >* { margin-right: %$spacing%px }
        >*:last-child { margin-right:0 }`,
    features :{$: 'group.init-group'}
  }
})

jb.component('layout.flex', {
  type: 'group.style',
  params: [
      { id: 'align', as: 'string', options: ',flex-start,flex-end,center,space-between,space-around' },
      { id: 'direction', as: 'string', options: ',row,row-reverse,column,column-reverse' },
      { id: 'wrap', as: 'string', options:',wrap' },
  ],
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h(ctrl),ctrl.ctx.data))),
    css: '{ display: flex; {?justify-content:%$align%;?} {?flex-direction:%$direction%;?} {?flex-wrap:%$wrap%;?} }',
    features :{$: 'group.init-group'}
  }
})

jb.component('flex-layout-container.align-main-axis', {
    type: 'feature',
    params: [
      { id: 'align', as: 'string', options: 'flex-start,flex-end,center,space-between,space-around', defaultValue: 'flex-start' }
    ],
    impl : (ctx,factor) => ({
      css: `{ justify-content: ${align} }`
    })
})

jb.component('flex-item.grow', {
    type: 'feature',
    params: [
      { id: 'factor', as: 'number', defaultValue: '1' }
    ],
    impl : (ctx,factor) => ({
      css: `{ flex-grow: ${factor} }`
    })
})

jb.component('flex-item.basis', {
    type: 'feature',
    params: [
      { id: 'factor', as: 'number', defaultValue: '1' }
    ],
    impl : (ctx,factor) => ({
      css: `{ flex-basis: ${factor} }`
    })
})

jb.component('flex-item.align-self', {
    type: 'feature',
    params: [
      { id: 'align', as: 'string', options: 'auto,flex-start,flex-end,center,baseline,stretch', defaultValue: 'auto' }
    ],
    impl : (ctx,align) => ({
      css: `{ align-self: ${align} }`
    })
})

// jb.component('flex-filler', {
//     type: 'control',
//     params: [
//         { id: 'title', as: 'string', defaultValue: 'flex filler' },
//         { id: 'basis', as: 'number', defaultValue: '1' },
//         { id: 'grow', as: 'number', defaultValue: '1' },
//         { id: 'shrink', as: 'number', defaultValue: '0' },
//     ],
//     impl: (ctx,title,basis,grow,shrink) => {
//       var css = [
//         `flex-basis: ${basis}`,
//         `flex-grow: ${grow}`,
//         `flex-shrink: ${shrink}`,
//       ].join('; ');

//       return jb_ui.Comp({ template: `<div style="${css}"></div>`},ctx)
//     }
// })


jb.component('responsive.only-for-phone', {
    type: 'feature',
    impl : () => ({
      cssClass: 'only-for-phone'
    })
})

jb.component('responsive.not-for-phone', {
    type: 'feature',
    impl : () => ({
      cssClass: 'not-for-phone'
    })
})
;

jb.component('group.section', {
  type: 'group.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('section',{class:'jb-group'},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h(ctrl),ctrl.ctx.data))),
    features:{$: 'group.init-group'}
  }
})


jb.component('group.div', {
  type: 'group.style',
	params: [
		{ id: 'groupClass', as: 'string' },
		{ id: 'itemClass', as: 'string' },
	],
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{ class: cmp.groupClass },
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h(ctrl,{class: cmp.itemClass}),ctrl.ctx.data))),
    features :{$: 'group.init-group'}
  }
})

jb.component('first-succeeding.style', {
  type: 'first-succeeding.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => {
      var ctrl = state.ctrls.filter(x=>x)[0];
      return ctrl && h(ctrl)
    },
    features :{$: 'group.init-group'}
  }
})

jb.component('group.ul-li', {
  type: 'group.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('ul',{ class: 'jb-itemlist'},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h('li', {class: 'jb-item'} ,h(ctrl)),ctrl.ctx.data))),
    css: `{ list-style: none; padding: 0; margin: 0;}
    >li { list-style: none; padding: 0; margin: 0;}`
  },
})

jb.component('group.expandable', {
  type: 'group.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('section',{ class: 'jb-group'},[
        h('div',{ class: 'header'},[
          h('div',{ class: 'title'}, state.title),
          h('button',{ class: 'mdl-button mdl-button--icon', onclick: _=> cmp.toggle(), title: cmp.expand_title() },
            h('i',{ class: 'material-icons'}, state.show ? 'keyboard_arrow_down' : 'keyboard_arrow_right')
          )
        ])
      ].concat(state.show ? state.ctrls.map(ctrl=> h('div',{ },h(ctrl))): [])
    ),
    css: `>.header { display: flex; flex-direction: row; }
        >.header>button:hover { background: none }
        >.header>button { margin-left: auto }
        >.header.title { margin: 5px }`,
    features :[
        {$: 'group.init-group' },
        {$: 'group.init-expandable' },
      ]
    },
})

jb.component('group.init-expandable', {
  type: 'feature', category: 'group:0',
  impl: ctx => ({
        init: cmp => {
            cmp.state.show = true;
            cmp.expand_title = () => cmp.show ? 'collapse' : 'expand';
            cmp.toggle = function () { cmp.show = !cmp.show; };
        },
  })
})

jb.component('group.accordion', {
  type: 'group.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('section',{ class: 'jb-group'},
        state.ctrls.map((ctrl,index)=> jb.ui.item(cmp,h('div',{ class: 'accordion-section' },[
          h('div',{ class: 'header', onclick: _=> cmp.show(index) },[
            h('div',{ class: 'title'}, ctrl.title),
            h('button',{ class: 'mdl-button mdl-button--icon', title: cmp.expand_title(ctrl) },
              h('i',{ class: 'material-icons'}, state.shown == index ? 'keyboard_arrow_down' : 'keyboard_arrow_right')
            )
          ])].concat(state.shown == index ? [h(ctrl)] : [])),ctrl.ctx.data)
    )),
    css: `>.accordion-section>.header { display: flex; flex-direction: row; }
        >.accordion-section>.header>button:hover { background: none }
        >.accordion-section>.header>button { margin-left: auto }
        >.accordion-section>.header>.title { margin: 5px }`,
      features : [
        {$: 'group.init-group' },
        {$: 'group.init-accordion' },
      ]
    },
})

jb.component('group.init-accordion', {
  type: 'feature', category: 'group:0',
  params: [
    { id: 'keyboardSupport', as: 'boolean' },
    { id: 'autoFocus', as: 'boolean' }
  ],
  impl: ctx => ({
    onkeydown: ctx.params.keyboardSupport,
    init: cmp => {
      cmp.state.shown = 0;
      cmp.expand_title = index =>
        index == cmp.state.shown ? 'collapse' : 'expand';

      cmp.show = index =>
        cmp.setState({shown: index});

      cmp.next = diff =>
        cmp.setState({shown: (cmp.state.index + diff + cmp.ctrls.length) % cmp.ctrls.length});
    },
    afterViewInit: cmp => {
      if (ctx.params.keyboardSupport) {
        cmp.onkeydown.filter(e=> e.keyCode == 33 || e.keyCode == 34) // pageUp/Down
            .subscribe(e=>
              cmp.next(e.keyCode == 33 ? -1 : 1))
      }
    }
  })
})

jb.component('group.tabs', {
  type: 'group.style',
  params: [
    { id: 'width', as : 'number' },
  ],
  impl :{$: 'style-by-control', __innerImplementation: true,
    modelVar: 'tabsModel',
    control :{$: 'group', controls: [
      {$: 'group', title: 'thumbs',
        features :{$: 'group.init-group'},
        style :{$: 'layout.horizontal' },
        controls :{$: 'dynamic-controls',
          itemVariable: 'tab',
          controlItems : '%$tabsModel/controls%',
          genericControl: {$: 'button',
            title: '%$tab/jb_title%',
            action :{$: 'write-value', value: '%$tab%', to: '%$selectedTab%' },
            style :{$: 'button.mdl-flat-ripple' },
            features: [
              {$: 'css.width', width: '%$width%' },
              {$: 'css', css: '{text-align: left}' }
            ]
          },
        },
      },
      ctx =>
        jb.val(ctx.exp('%$selectedTab%')),
    ],
    features : [
        {$: 'var', name: 'selectedTab', value: '%$tabsModel/controls[0]%', mutable: true },
        {$: 'group.init-group'},
    ]
  }}
})

jb.component('toolbar.simple', {
  type: 'group.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{class:'toolbar'},
        state.ctrls.map(ctrl=> h(ctrl))),
    css: `{
            display: flex;
            background: #F5F5F5;
            height: 33px;
            width: 100%;
            border-bottom: 1px solid #D9D9D9;
            border-top: 1px solid #fff;
        }
        >* { margin-right: 0 }`,
    features :{$: 'group.init-group'}
  }
})
;

jb.component('table.with-headers', {
  type: 'table.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('table',{},[
        h('thead',{},h('tr',{},cmp.fields.map(f=>h('th',{'jb-ctx': f.ctxId, style: { width: f.width ? f.width + 'px' : ''} },f.title)) )),
        h('tbody',{class: 'jb-drag-parent'},
            state.items.map(item=> jb.ui.item(cmp,h('tr',{ class: 'jb-item', 'jb-ctx': jb.ui.preserveCtx(cmp.ctx.setData(item))},cmp.fields.map(f=>
              h('td', { 'jb-ctx': f.ctxId, class: f.class }, f.control ? h(f.control(item)) : f.fieldData(item))))
              ,item))
        ),
        state.items.length == 0 ? 'no items' : ''
        ]),
    features:{$: 'table.init'},
    css: `{border-spacing: 0; text-align: left}
    >tbody>tr>td { padding-right: 2px }
    `
  }
})



jb.component('table.mdl', {
  type: 'table.style',
  params: [
    { id: 'classForTable', as: 'string', defaultValue: 'mdl-data-table mdl-js-data-table mdl-data-table--selectable mdl-shadow--2dp'},
    { id: 'classForTd', as: 'string', defaultValue: 'mdl-data-table__cell--non-numeric'},
  ],
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('table',{ class: cmp.classForTable },[
        h('thead',{},h('tr',{},cmp.fields.map(f=>h('th',{'jb-ctx': f.ctxId, class: cmp.classForTd, style: { width: f.width ? f.width + 'px' : ''} },f.title)) )),
        h('tbody',{class: 'jb-drag-parent'},
            state.items.map(item=> jb.ui.item(cmp,h('tr',{ class: 'jb-item', 'jb-ctx': jb.ui.preserveCtx(cmp.ctx.setData(item))},cmp.fields.map(f=>
              h('td', { 'jb-ctx': f.ctxId, class: (f.class + ' ' + cmp.classForTd).trim() }, f.control ? h(f.control(item)) : f.fieldData(item))))
              ,item))
        ),
        state.items.length == 0 ? 'no items' : ''
        ]),
    features:{$: 'table.init'},
  }
})
;


jb.component('picklist.native', {
  type: 'picklist.style',
  impl :{$: 'custom-style', 
      features :{$: 'field.databind' },
      template: (cmp,state,h) => h('select', { value: state.model, onchange: e => cmp.jbModel(e.target.value) },
          state.options.map(option=>h('option',{value: option.code},option.text))
        ),
    css: `
{ display: block; width: 100%; height: 34px; padding: 6px 12px; font-size: 14px; line-height: 1.42857; color: #555555; background-color: #fff; background-image: none; border: 1px solid #ccc; border-radius: 4px; -webkit-box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075); box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075); -webkit-transition: border-color ease-in-out 0.15s, box-shadow ease-in-out 0.15s; -o-transition: border-color ease-in-out 0.15s, box-shadow ease-in-out 0.15s; transition: border-color ease-in-out 0.15s, box-shadow ease-in-out 0.15s; }
:focus { border-color: #66afe9; outline: 0; -webkit-box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075), 0 0 8px rgba(102, 175, 233, 0.6); box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075), 0 0 8px rgba(102, 175, 233, 0.6); }
::-webkit-input-placeholder { color: #999; }`
  }
})

jb.component('picklist.native-md-look', {
  type: 'picklist.style',
  impl :{$: 'custom-style', 
      features :{$: 'field.databind' },
      template: (cmp,state,h) => h('div',{},h('select', { value: state.model, onchange: e => cmp.jbModel(e.target.value) },
          state.options.map(option=>h('option',{value: option.code},option.text)))),
    css: `>select {  appearance: none; -webkit-appearance: none; font-family: inherit;
  background-color: transparent;
  padding: 6px 0;
  font-size: 14px;
  width: 100%;
  color: rgba(0,0,0, 0.82);
  border: none;
  border-bottom: 1px solid rgba(0,0,0, 0.12); }

  {
    font-family: 'Roboto','Helvetica','Arial',sans-serif;
    position: relative;
  }
  >select:focus { border-color: #3F51B5; border-width: 2px}

  :after { position: absolute;
        top: 0.75em;
        right: 0.5em;
        /* Styling the down arrow */
        width: 0;
        height: 0;
        padding: 0;
        content: '';
        border-left: .25em solid transparent;
        border-right: .25em solid transparent;
        border-top: .375em solid rgba(0,0,0, 0.12);
        pointer-events: none; }`
  }
})


jb.component('picklist.mdl', {
  type: 'picklist.style',
  params: [
    {id: 'noLabel', type: 'boolean', as: 'boolean'},
  ],
  impl :{$: 'custom-style', 
      template: (cmp,state,h) => h('div',{ class:'mdl-textfield mdl-js-textfield mdl-textfield--floating-label getmdl-select getmdl-select__fix-height'},[
        h('input', { class: 'mdl-textfield__input', id: 'input_' + state.fieldId, type: 'text',
            value: state.model,
            readonly: true,
            tabIndex: -1
        }),
        h('label',{for: 'input_' + state.fieldId},
          h('i',{class: 'mdl-icon-toggle__label material-icons'},'keyboard_arrow_down')
        ),
//        h('label',{class: 'mdl-textfield__label', for: 'input_' + state.fieldId},state.title),
        h('ul',{for: 'input_' + state.fieldId, class: 'mdl-menu mdl-menu--bottom-left mdl-js-menu',
            onclick: e =>
              cmp.jbModel(e.target.getAttribute('code'))
          },
          state.options.map(option=>h('li',{class: 'mdl-menu__item', code: option.code},option.text))
        )
      ]),
      css: '>label>i {float: right; margin-top: -30px;}',
      features : [ 
        {$: 'field.databind' },
        {$: 'mdl-style.init-dynamic'},
      ],
  }
})

jb.component('picklist.selection-list', {
  type: 'picklist.style',
  params: [
    { id: 'width', as : 'number' },
  ],
  impl :{$: 'style-by-control', __innerImplementation: true,
    modelVar: 'picklistModel',
    control :{$: 'itemlist',
      watchItems: false, 
      items: '%$picklistModel/options%',
      style :{ $: 'itemlist.ul-li' },
      controls :{$: 'label', 
        title: '%text%', 
        style :{$: 'label.mdl-ripple-effect' }, 
        features: [
          {$: 'css.width', width: '%$width%' }, 
          {$: 'css', css: '{text-align: left}' }
        ]
      },
      features :{$: 'itemlist.selection', 
        onSelection :{$: 'write-value', value: '%code%', to: '%$picklistModel/databind%' } 
      }
    }
  }
})

jb.component('picklist.groups', {
  type: 'picklist.style',
  impl :{$: 'custom-style', 
      features :{$: 'field.databind' },
      template: (cmp,state,h) => h('select', { value: state.model, onchange: e => cmp.jbModel(e.target.value) },
          (state.hasEmptyOption ? [h('option',{value:''},'')] : []).concat(
            state.groups.map(group=>h('optgroup',{label: group.text},
              group.options.map(option=>h('option',{value: option.code},option.text))
              ))
      )),
    css: `
 { display: block; width: 100%; height: 34px; padding: 6px 12px; font-size: 14px; line-height: 1.42857; color: #555555; background-color: #fff; background-image: none; border: 1px solid #ccc; border-radius: 4px; -webkit-box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075); box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075); -webkit-transition: border-color ease-in-out 0.15s, box-shadow ease-in-out 0.15s; -o-transition: border-color ease-in-out 0.15s, box-shadow ease-in-out 0.15s; transition: border-color ease-in-out 0.15s, box-shadow ease-in-out 0.15s; }
select:focus { border-color: #66afe9; outline: 0; -webkit-box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075), 0 0 8px rgba(102, 175, 233, 0.6); box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075), 0 0 8px rgba(102, 175, 233, 0.6); }
select::-webkit-input-placeholder { color: #999; }`
  }
})
;

jb.component('property-sheet.titles-above', {
  type: 'group.style',
  params: [
    { id: 'spacing', as: 'number', defaultValue: 20 }
  ],
  impl :{$: 'custom-style', 
    features :{$: 'group.init-group'},
    template: (cmp,state,h) => h('div',{}, state.ctrls.map(ctrl=>
      h('div',{ class: 'property'},[
            h('label',{ class: 'property-title'},ctrl.title),
            h(ctrl)
    ]))),
    css: `>.property { margin-bottom: %$spacing%px }
      >.property:last-child { margin-bottom:0 }
      >.property>.property-title {
        width:100px;
        overflow:hidden;
        text-overflow:ellipsis;
        vertical-align:top;
        margin-top:2px;
        font-size:14px;
      }
      >.property>div { display:inline-block }`
  }
})

jb.component('property-sheet.titles-above-float-left', {
  type: 'group.style',
  params: [
    { id: 'spacing', as: 'number', defaultValue: 20 },
    { id: 'fieldWidth', as: 'number', defaultValue: 200 },
  ],
  impl :{$: 'custom-style', 
    features :{$: 'group.init-group'},
    template: (cmp,state,h) => h('div',{ class: 'clearfix'}, state.ctrls.map(ctrl=>
      h('div',{ class: 'property clearfix'},[
          h('label',{ class: 'property-title'},ctrl.title),
          h(ctrl)
    ]))),
    css: `>.property { 
          float: left;
          width: %$fieldWidth%px;
          margin-right: %$spacing%px;
        }
      .clearfix:after {
        content: "";
        clear: both;
      }
      >.property:last-child { margin-right:0 }
      >.property>.property-title {
        margin-bottom: 3px;
        overflow:hidden;
        text-overflow:ellipsis;
        vertical-align:top;
        font-size:14px;
      }`,
  }
})

jb.component('property-sheet.titles-left', {
  type: 'group.style',
  params: [
    { id: 'vSpacing', as: 'number', defaultValue: 20 },
    { id: 'hSpacing', as: 'number', defaultValue: 20 },
    { id: 'titleWidth', as: 'number', defaultValue: 100 },
  ],
  impl :{$: 'custom-style', 
    features :{$: 'group.init-group'},
    template: (cmp,state,h) => h('div',{}, state.ctrls.map(ctrl=>
      h('div',{ class: 'property'},[
          h('label',{ class: 'property-title'}, ctrl.title),
          h(ctrl)
    ]))),
    css: `>.property { margin-bottom: %$vSpacing%px; display: flex }
      >.property:last-child { margin-bottom:0px }
      >.property>.property-title {
        width: %$titleWidth%px;
        overflow:hidden;
        text-overflow:ellipsis;
        vertical-align:top;
        margin-top:2px;
        font-size:14px;
        margin-right: %$hSpacing%px;
      }
      >.property>*:last-child { margin-right:0 }`
  }
})
;

jb.component('editable-boolean.checkbox', {
  type: 'editable-boolean.style',
  impl :{$: 'custom-style', 
      features :{$: 'field.databind' },
      template: (cmp,state,h) => h('input', { type: 'checkbox',
        checked: state.model, 
        onchange: e => cmp.jbModel(e.target.checked), 
        onkeyup: e => cmp.jbModel(e.target.checked,'keyup')  })
    }
})

jb.component('editable-boolean.checkbox-with-title', {
  type: 'editable-boolean.style',
  impl :{$: 'custom-style', 
      features :{$: 'field.databind' },
      template: (cmp,state,h) => h('div',{}, [h('input', { type: 'checkbox',
        checked: state.model, 
        onchange: e => cmp.jbModel(e.target.checked), 
        onkeyup: e => cmp.jbModel(e.target.checked,'keyup')  }), state.text])
  }
})


jb.component('editable-boolean.expand-collapse', {
  type: 'editable-boolean.style',
  impl :{$: 'custom-style', 
      features :{$: 'field.databind' },
      template: (cmp,state,h) => h('div',{},[
          h('input', { type: 'checkbox',
            checked: state.model, 
            onchange: e => cmp.jbModel(e.target.checked), 
            onkeyup: e => cmp.jbModel(e.target.checked,'keyup')  }, state.text),
          h('i',{class:'material-icons noselect', onclick: _=> cmp.toggle() }, state.model ? 'keyboard_arrow_down' : 'keyboard_arrow_right')
      ]),
      css: `>i { font-size:16px; cursor: pointer; }
          >input { display: none }`
  }
})

jb.component('editable-boolean.mdl-slide-toggle', {
  type: 'editable-boolean.style',
  impl :{$: 'custom-style', 
      template: (cmp,state,h) => h('label',{class:'mdl-switch mdl-js-switch mdl-js-ripple-effect', for: 'switch_' + state.fieldId },[
        h('input', { type: 'checkbox', class: 'mdl-switch__input', id: 'switch_' + state.fieldId,
          checked: state.model, onchange: e => cmp.jbModel(e.target.checked) }),
        h('span',{class:'mdl-switch__label'},state.text)
      ]),
      features :[
          {$: 'field.databind' },
          {$: 'editable-boolean.keyboard-support' },
          {$: 'mdl-style.init-dynamic'}
      ],
  }
})
;

jb.component('card.card', {
  type: 'group.style',
	params: [
    { id: 'width', as: 'number', defaultValue: 320 },
		{ id: 'shadow', as: 'string', options: '2,3,4,6,8,16', defaultValue: '2' }
	],
	impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{ class: `mdl-card mdl-shadow--${cmp.shadow}dp` },
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h(ctrl,{class: cmp.itemClass}),ctrl.ctx.data))),
    features :{$: 'group.init-group'},
		css: '{ width: %$width%px }'
  }
})

jb.component('card.media-group', {
  type: 'group.style',
  impl :{$:'group.div', groupClass: 'mdl-card__media' },
})

jb.component('card.actions-group', {
  type: 'group.style',
  impl :{$:'group.div', groupClass: 'mdl-card__actions mdl-card--border' },
})

jb.component('card.menu', {
  type: 'group.style',
  impl :{$:'group.div', groupClass: 'mdl-card__menu' },
})
;

(function() {

class NodeLine extends jb.ui.Component {
	constructor(props) {
		super();
		this.state.expanded = props.tree.expanded[props.path];
		var tree = props.tree, path = props.path;
		var model = tree.nodeModel;
		this.setState({
			title: model.title(path,!tree.expanded[path]),
			icon: model.icon ? model.icon(path) : 'radio_button_unchecked'
		})

		this.state.flip = _ => {
			tree.expanded[path] = !(tree.expanded[path]);
			this.setState({expanded:tree.expanded[path]});
			tree.redraw();
		};
	}
	componentWillUpdate() {
		var tree = this.props.tree, path = this.props.path;
		var model = tree.nodeModel;
		this.setState({
			title: model.title(path,!tree.expanded[path]),
			icon: model.icon ? model.icon(path) : 'radio_button_unchecked'
		})
	}
	render(props,state) {
		var h = jb.ui.h, tree= props.tree, model = props.tree.nodeModel;

		var collapsed = tree.expanded[props.path] ? '' : ' collapsed';
		var nochildren = model.isArray(props.path) ? '' : ' nochildren';

		return h('div',{ class: `treenode-line${collapsed}`},[
			h('button',{class: `treenode-expandbox${nochildren}`, onclick: _=> state.flip() },[
				h('div',{ class: 'frame'}),
				h('div',{ class: 'line-lr'}),
				h('div',{ class: 'line-tb'}),
			]),
			h('i',{class: 'material-icons', style: 'font-size: 16px; margin-left: -4px; padding-right:2px'},state.icon),
			h('span',{class: 'treenode-label'}, state.title),
		])
	}
}

class TreeNode extends jb.ui.Component {
	constructor() {
		super();
	}
	render(props,state) {
		var h = jb.ui.h, tree = props.tree, path = props.path, model = props.tree.nodeModel;
		var disabled = model.disabled && model.disabled(props.path) ? 'jb-disabled' : '';
		var clz = [props.class, model.isArray(path) ? 'jb-array-node': '',disabled].filter(x=>x).join(' ');

		return h('div',{class: clz, path: props.path},
			[h(NodeLine,{ tree: tree, path: path })].concat(!tree.expanded[path] ? [] : h('div',{ class: 'treenode-children'} ,
					tree.nodeModel.children(path).map(childPath=>
						h(TreeNode,{ tree: tree, path: childPath, class: 'treenode' + (tree.selected == childPath ? ' selected' : '') })
					))
			))

	}
}

 //********************* jBart Components

jb.component('tree', {
	type: 'control',
	params: [
		{ id: 'nodeModel', type: 'tree.nodeModel', dynamic: true, essential: true },
		{ id: 'style', type: "tree.style", defaultValue: { $: "tree.ul-li" }, dynamic: true },
		{ id: 'features', type: "feature[]", dynamic: true }
	],
	impl: ctx => {
		var nodeModel = ctx.params.nodeModel();
		if (!nodeModel)
			return jb.logException('missing nodeModel in tree');
		var tree = { nodeModel: nodeModel };
		var ctx = ctx.setVars({$tree: tree});
		return jb.ui.ctrl(ctx, {
			class: 'jb-tree', // define host element to keep the wrapper
			beforeInit: (cmp,props) => {
				cmp.tree = Object.assign( tree, {
					redraw: strong => { // needed after dragula that changes the DOM
						cmp.setState({empty: strong});
						if (strong)
							jb.delay(1).then(_=>
								cmp.setState({empty: false}))
					},
					expanded: jb.obj(tree.nodeModel.rootPath, true),
					elemToPath: el =>
						jb.ui.closest(el,'.treenode') && jb.ui.closest(el,'.treenode').getAttribute('path'),
					selectionEmitter: new jb.rx.Subject(),
				})
			},
			afterViewInit: cmp =>
				tree.el = cmp.base
		})
	}
})

jb.component('tree.ul-li', {
	type: 'tree.style',
	impl :{$: 'custom-style',
		template: (cmp,state,h) => {
			var tree = cmp.tree;
			return h('div',{},
				state.empty ? h('span') : h(TreeNode,{ tree: tree, path: tree.nodeModel.rootPath,
				class: 'jb-control-tree treenode' + (tree.selected == tree.nodeModel.rootPath ? ' selected': '') })
			)
		}
	}
})

jb.component('tree.no-head', {
	type: 'tree.style',
	impl :{$: 'custom-style',
		template: (cmp,state,h) => {
		var tree = cmp.tree, path = tree.nodeModel.rootPath;
		return h('div',{},tree.nodeModel.children(path).map(childPath=>
				 h(TreeNode,{ tree: tree, path: childPath, class: 'treenode' + (tree.selected == childPath ? ' selected' : '') }))
		)}
	}
})

jb.component('tree.selection', {
  type: 'feature',
  params: [
	  { id: 'databind', as: 'ref' },
	  { id: 'onSelection', type: 'action', dynamic: true },
	  { id: 'autoSelectFirst', type: 'boolean' }
  ],
  impl: context=> ({
	    onclick: true,
  		afterViewInit: cmp => {
  		  var tree = cmp.tree;

  		  var databindObs = jb.ui.refObservable(context.params.databind,cmp).map(e=>jb.val(e.ref));

		  tree.selectionEmitter
		  	.merge(databindObs)
		  	.merge(cmp.onclick.map(event =>
		  		tree.elemToPath(event.target)))
		  	.filter(x=>x)
//	  		.distinctUntilChanged()
		  	.subscribe(selected=> {
		  	  if (tree.selected == selected)
		  	  	return;
			  tree.selected = selected;
			  selected.split('~').slice(0,-1).reduce(function(base, x) {
				  var path = base ? (base + '~' + x) : x;
				  tree.expanded[path] = true;
				  return path;
			  },'')
			  if (context.params.databind)
				  jb.writeValue(context.params.databind, selected);
			  context.params.onSelection(cmp.ctx.setData(selected));
			  tree.redraw();
		  });

		  cmp.onclick.subscribe(_=>
		  	tree.regainFocus && tree.regainFocus()
		  );

		  // first auto selection selection
		  var first_selected = jb.val(context.params.databind);
		  if (!first_selected && context.params.autoSelectFirst) {
			  var first = jb.ui.find(tree.el.parentNode,'.treenode')[0];
			  first_selected = tree.elemToPath(first);
		  }
		  if (first_selected)
  			jb.delay(1).then(() =>
  				tree.selectionEmitter.next(first_selected))
  		},
  	})
})

jb.component('tree.keyboard-selection', {
	type: 'feature',
	params: [
		{ id: 'onKeyboardSelection', type: 'action', dynamic: true },
		{ id: 'onEnter', type: 'action', dynamic: true },
		{ id: 'onRightClickOfExpanded', type: 'action', dynamic: true },
		{ id: 'autoFocus', type: 'boolean' },
		{ id: 'applyMenuShortcuts', type: 'menu.option', dynamic: true },
	],
	impl: context => ({
			onkeydown: true,
			afterViewInit: cmp=> {
				var tree = cmp.tree;
				cmp.base.setAttribute('tabIndex','0');

				var keyDownNoAlts = cmp.onkeydown.filter(e=>
					!e.ctrlKey && !e.altKey);

				tree.regainFocus = cmp.getKeyboardFocus = cmp.getKeyboardFocus || (_ => {
					jb.ui.focus(cmp.base,'tree.keyboard-selection regain focus',context);
					return false;
				});

				if (context.params.autoFocus)
					jb.ui.focus(cmp.base,'tree.keyboard-selection init autofocus',context);

				keyDownNoAlts
					.filter(e=> e.keyCode == 13)
						.subscribe(e =>
							runActionInTreeContext(context.params.onEnter))

				keyDownNoAlts.filter(e=> e.keyCode == 38 || e.keyCode == 40)
					.map(event => {
//						event.stopPropagation();
						var diff = event.keyCode == 40 ? 1 : -1;
						var nodes = jb.ui.findIncludeSelf(tree.el,'.treenode');
						var selected = jb.ui.findIncludeSelf(tree.el,'.treenode.selected')[0];
						return tree.elemToPath(nodes[nodes.indexOf(selected) + diff]) || tree.selected;
					}).subscribe(x=>
						tree.selectionEmitter.next(x))
				// expand collapse
				keyDownNoAlts
					.filter(e=> e.keyCode == 37 || e.keyCode == 39)
					.subscribe(event => {
//						event.stopPropagation();
						var isArray = tree.nodeModel.isArray(tree.selected);
						if (!isArray || (tree.expanded[tree.selected] && event.keyCode == 39))
							runActionInTreeContext(context.params.onRightClickOfExpanded);
						if (isArray && tree.selected) {
							tree.expanded[tree.selected] = (event.keyCode == 39);
							tree.redraw()
						}
					});

				function runActionInTreeContext(action) {
					jb.ui.wrapWithLauchingElement(action,
						context.setData(tree.selected), jb.ui.findIncludeSelf(tree.el,'.treenode.selected>.treenode-line')[0])()
				}
				// menu shortcuts - delay in order not to block registration of other features
		    jb.delay(1).then(_=> cmp.base && (cmp.base.onkeydown = e => {
					if ((e.ctrlKey || e.altKey || e.keyCode == 46) // also Delete
					 && (e.keyCode != 17 && e.keyCode != 18)) { // ctrl or alt alone
						var menu = context.params.applyMenuShortcuts(context.setData(tree.selected));
						if (menu && menu.applyShortcut && menu.applyShortcut(e))
							return false;  // stop propagation
					}
					return true;
				}))
			}
		})
})

jb.component('tree.regain-focus', {
	type: 'action',
	impl : ctx =>
		ctx.vars.$tree && ctx.vars.$tree.regainFocus && ctx.vars.$tree.regainFocus()
})

jb.component('tree.redraw', {
	type: 'action',
  params: [
    { id: 'strong', type: 'boolean', as: 'boolean' }
  ],
	impl : (ctx,strong) =>
		ctx.vars.$tree && ctx.vars.$tree.regainFocus && ctx.vars.$tree.redraw(strong)
})

jb.component('tree.drag-and-drop', {
  type: 'feature',
  params: [
//	  { id: 'afterDrop', type: 'action', dynamic: true, essential: true },
  ],
  impl: ctx => ({
  		onkeydown: true,
  		afterViewInit: cmp => {
  			var tree = cmp.tree;
        var drake = tree.drake = dragula([], {
				      moves: el =>
					         jb.ui.matches(el,'.jb-array-node>.treenode-children>div')
	      });
        drake.containers = jb.ui.find(cmp.base,'.jb-array-node>.treenode-children');
          //jb.ui.findIncludeSelf(cmp.base,'.jb-array-node').map(el=>el.children()).filter('.treenode-children').get();

	      drake.on('drag', function(el, source) {
	          var path = tree.elemToPath(el.firstElementChild)
	          el.dragged = { path: path, expanded: tree.expanded[path]}
	          delete tree.expanded[path]; // collapse when dragging
	        })

	      drake.on('drop', (dropElm, target, source,targetSibling) => {
	            if (!dropElm.dragged) return;
				      dropElm.parentNode.removeChild(dropElm);
	            tree.expanded[dropElm.dragged.path] = dropElm.dragged.expanded; // restore expanded state
      				var state = treeStateAsVals(tree);
      				var targetPath = targetSibling ? tree.elemToPath(targetSibling) : addOneToIndex(tree.elemToPath(target.lastElementChild));
      				if (!targetPath)
      					debugger;
      				tree.nodeModel.move(dropElm.dragged.path,targetPath);
      				restoreTreeStateFromVals(tree,state);
      				dropElm.dragged = null;
      				tree.redraw(true);
	      });

	        // ctrl up and down
    		cmp.onkeydown.filter(e=>
    				e.ctrlKey && (e.keyCode == 38 || e.keyCode == 40))
    				.subscribe(e=> {
      					var diff = e.keyCode == 40 ? 2 : -1;
      					var selectedIndex = Number(tree.selected.split('~').pop());
      					if (isNaN(selectedIndex)) return;
      					var no_of_siblings = Array.from(cmp.base.querySelector('.treenode.selected').parentNode.children).length;
                //$($('.treenode.selected').parents('.treenode-children')[0]).children().length;
      					var index = (selectedIndex + diff+ no_of_siblings+1) % (no_of_siblings + 1);
      					var path = tree.selected.split('~').slice(0,-1).join('~');
      					var state = treeStateAsVals(tree);
      					tree.nodeModel.move(tree.selected, tree.selected.split('~').slice(0,-1).concat([index]).join('~'))
      					restoreTreeStateFromVals(tree,state);
      			})
      		},
      		doCheck: function(cmp) {
      			var tree = cmp.tree;
    		  	if (tree.drake)
    			     tree.drake.containers = jb.ui.find(cmp.base,'.jb-array-node>.treenode-children');
    				       //$(cmp.base).findIncludeSelf('.jb-array-node').children().filter('.treenode-children').get();
      		}
  	})
})


treeStateAsVals = tree => ({
	selected: pathToVal(tree.nodeModel,tree.selected),
	expanded: jb.entries(tree.expanded).filter(e=>e[1]).map(e=>pathToVal(tree.nodeModel,e[0]))
})

restoreTreeStateFromVals = (tree,vals) => {
	tree.selected = valToPath(tree.nodeModel,vals.selected);
	tree.expanded = {};
	vals.expanded.forEach(v=>tree.expanded[valToPath(tree.nodeModel,v)] = true)
}

pathToVal = (model,path) =>
	model.refHandler.val(model.refHandler.refOfPath(path.split('~')))

valToPath = (model,val) => {
	var ref = model.refHandler.asRef(val);
	return ref ? ref.$jb_path.join('~') : ''
}

addOneToIndex = path => {
	if (!path) debugger;
	var index = Number(path.slice(-1)) + 1;
	return path.split('~').slice(0,-1).concat([index]).join('~')
}


})()
;

(function() { var st = jb.studio;

st.message = function(message,error) {
  var el = document.querySelector('.studio-message');
	el.textContent = message;
  el.style.background = error ? 'red' : '#327DC8';
  el.style.animation = '';
	jb.delay(1).then(()=>	el.style.animation = 'slide_from_top 5s ease')
}

// ********* Components ************

jb.component('studio.message', {
	type: 'action',
	params: [ { id: 'message', as: 'string' } ],
	impl: (ctx,message) =>
		st.message(message)
})

jb.component('studio.redraw-studio', {
	type: 'action',
	impl: ctx =>
    	st.redrawStudio && st.redrawStudio()
})

jb.component('studio.last-edit', {
	type: 'data',
	params: [
		{ id: 'justNow', as: 'boolean', type: 'boolean', defaultValue: true },
	],
	impl: (ctx,justNow) => {
		var now = new Date().getTime();
		var lastEvent = st.compsHistory.slice(-1).map(x=>x.opEvent).filter(x=>x)
			.filter(r=>
				!justNow || now - r.timeStamp < 1000)[0];
		return lastEvent && (lastEvent.insertedPath || lastEvent.path).join('~');
	}
})

jb.component('studio.goto-last-edit', {
	type: 'action',
	impl: {$:'action.if', condition: {$: 'studio.last-edit'}, then: {$: 'studio.goto-path', path: {$: 'studio.last-edit'}} }
})

jb.component('studio.goto-path', {
	type: 'action',
	params: [
		{ id: 'path', as: 'string' },
	],
	impl :{$runActions: [
		{$: 'dialog.close-containing-popup' },
		{$: 'write-value', to: '%$studio/profile_path%', value: '%$path%' },
		{$if :{$: 'studio.is-of-type', type: 'control', path: '%$path%'},
			then: {$runActions: [
				{$: 'studio.open-control-tree'},
//				{$: 'studio.open-properties', focus: true}
			]},
			else :{$: 'studio.open-component-in-jb-editor', path: '%$path%' }
		}
	]}
})

jb.component('studio.project-source',{
	params: [
		{ id: 'project', as: 'string', defaultValue: '%$studio/project%' }
	],
	impl: (context,project) => {
		if (!project) return;
		var comps = jb.entries(st.previewjb.comps).map(x=>x[0]).filter(x=>x.indexOf(project) == 0);
		return comps.map(comp=>st.compAsStr(comp)).join('\n\n')
	}
})

jb.component('studio.comp-source',{
	params: [
		{ id: 'comp', as: 'string', defaultValue: { $: 'studio.currentProfilePath' } }
	],
	impl: (context,comp) =>
		st.compAsStr(comp.split('~')[0])
})

jb.component('studio.dynamic-options-watch-new-comp', {
  type: 'feature',
  impl :{$: 'picklist.dynamic-options',
        recalcEm: () =>
          st.scriptChange.filter(e => e.path.length == 1)
  }
})


})();
;

jb.component('tree.json-read-only',{
	type: 'tree.nodeModel',
	params: [
		{ id: 'object' },
		{ id: 'rootPath', as: 'string'}
	],
	impl: function(context, json, rootPath) {
		return new ROjson(json,rootPath)
	}
})

class ROjson {
	constructor(json,rootPath) {
		this.json = json;
		this.rootPath = rootPath;
	}
	children(path) {
		var val = this.val(path);
		var out = [];
		if (typeof val == 'object')
			out = Object.getOwnPropertyNames(val || {});
		if (Array.isArray(val))
			out = out.slice(0,-1);
		return out.filter(p=>p.indexOf('$jb_') != 0).map(p=>path+'~'+p);
	}
	val(path) {
		if (path.indexOf('~') == -1)
			return jb.val(this.json);
		return jb.val(path.split('~').slice(1).reduce((o,p) =>o[p], this.json))
	}
	isArray(path) {
		var val = this.val(path);
		return typeof val == 'object' && val !== null;
	}
	icon() { 
		return '' 
	}
	title(path,collapsed) {
		var val = this.val(path);
		var prop = path.split('~').pop();
		var h = jb.ui.h;
		if (val == null) 
			return h('div',{},prop + ': null');
		if (!collapsed && typeof val == 'object')
			return h('div',{},prop);

		if (typeof val != 'object')
			return h('div',{},[prop + ': ',h('span',{class:'treenode-val', title: ''+val},jb.ui.limitStringLength(''+val,20))]);

		return h('div',{},[h('span',{},prop + ': ')].concat(
			Object.getOwnPropertyNames(val).filter(p=>p.indexOf('$jb_') != 0).filter(p=> ['string','boolean','number'].indexOf(typeof val[p]) != -1)
			.map(p=> [h('span',{class:'treenode-val', title: ''+val[p]},jb.ui.limitStringLength(''+val[p],20)) ])))
	}
}

jb.component('tree.json',{
	type: 'tree.nodeModel',
	params: [
		{ id: 'object'},
		{ id: 'rootPath', as: 'string'}
	],
	impl: function(context, json, rootPath) {
		return new Json(json,rootPath)
	}
})

class Json {
	constructor(json,rootPath) {
		this.json = json;
		this.rootPath = rootPath;
	}
	children(path) {
		var val = this.val(path);
		var out = [];
		if (typeof val == 'object')
			out = Object.getOwnPropertyNames(val || {});
		if (Array.isArray(val))
			out = out.slice(0,-1);
		return out.filter(p=>p.indexOf('$jb_') != 0).map(p=>path+'~'+p);
	}
	val(path) {
		if (path.indexOf('~') == -1)
			return jb.val(this.json);
		return jb.val(path.split('~').slice(1).reduce((o,p) =>o[p], this.json))
	}
	isArray(path) {
		var val = this.val(path);
		return typeof val == 'object' && val !== null;
	}
	icon() { 
		return '' 
	}
	title(path,collapsed) {
		var val = this.val(path);
		var prop = path.split('~').pop();
		var h = jb.ui.h;
		if (val == null) 
			return h(prop + ': null');
		if (!collapsed && typeof val == 'object')
			return h('div',{},prop);

		if (typeof val != 'object')
			return h('div',{},[prop + ': ',h('span',{class:'treenode-val', title: val},jb.ui.limitStringLength(val,20))]);

		return h('div',{},[h('span',{},prop + ': ')].concat(
			Object.getOwnPropertyNames(val).filter(p=> typeof val[p] == 'string' || typeof val[p] == 'number' || typeof val[p] == 'boolean')
			.map(p=> [h('span',{class:'treenode-val', title: ''+val[p]},jb.ui.limitStringLength(''+val[p],20)) ])))
	}
	modify(op,path,args,ctx) {
		op.call(this,path,args);
	}
	move(path,args) { // drag & drop
		var pathElems = args.dragged.split('~');
		pathElems.shift();
		var dragged = pathElems.reduce((o,p)=>o[p],this.json);
		var arr = this.val(path);
		if (Array.isArray(arr)) {
			var draggedIndex = Number(args.dragged.split('~').pop());
			arr.splice(draggedIndex,1);
			var index = (args.index == -1) ? arr.length : args.index;
			arr.splice(index,0,dragged);
		}
	}
}
;

(function() { var st = jb.studio;

//  var types = ['focus','apply','check','suggestions','writeValue','render','probe','setState'];
jb.issuesTolog = [];

function compsRef(val,opEvent) {
  if (typeof val == 'undefined')
    return st.previewjb.comps;
  else {
		// if (val.$jb_historyIndex && val == st.compsHistory[val.$jb_historyIndex].after)
		// 	st.compsHistory.slice()

		val.$jb_selectionPreview = opEvent && opEvent.srcCtx && opEvent.srcCtx.vars.selectionPreview;
		if (!val.$jb_selectionPreview)
  		st.compsHistory.push({before: st.previewjb.comps, after: val, opEvent: opEvent, undoIndex: st.undoIndex});

    st.previewjb.comps = val;
    if (opEvent)
      st.undoIndex = st.compsHistory.length;
  }
}

st.compsRefHandler = new jb.ui.ImmutableWithPath(compsRef);
st.compsRefHandler.resourceChange.subscribe(_=>st.lastStudioActivity= new Date().getTime())
// adaptors

Object.assign(st,{
  val: (v) =>
    st.compsRefHandler.val(v),
  writeValue: (ref,value,srcCtx) =>
    st.compsRefHandler.writeValue(ref,value,srcCtx),
  objectProperty: (obj,prop) =>
    st.compsRefHandler.objectProperty(obj,prop),
  splice: (ref,args,srcCtx) =>
    st.compsRefHandler.splice(ref,args,srcCtx),
  push: (ref,value,srcCtx) =>
    st.compsRefHandler.push(ref,value,srcCtx),
  merge: (ref,value,srcCtx) =>
    st.compsRefHandler.merge(ref,value,srcCtx),
  isRef: (ref) =>
    st.compsRefHandler.isRef(ref),
  asRef: (obj) =>
    st.compsRefHandler.asRef(obj),
  refreshRef: (ref) =>
    st.compsRefHandler.refresh(ref),
  scriptChange: st.compsRefHandler.resourceChange,
  refObservable: (ref,cmp,settings) =>
  	st.compsRefHandler.refObservable(ref,cmp,settings),
  refOfPath: (path,silent) =>
  	st.compsRefHandler.refOfPath(path.split('~'),silent),
  parentPath: path =>
		path.split('~').slice(0,-1).join('~'),
  valOfPath: (path,silent) =>
  	st.val(st.refOfPath(path,silent)),
  compNameOfPath: (path,silent) => {
    if (path.indexOf('~') == -1)
      return 'jb-component';
    if (path.match(/~\$vars$/)) return;
    var prof = st.valOfPath(path,silent); // + (path.indexOf('~') == -1 ? '~impl' : '');
  	return jb.compName(prof) || jb.compName(prof,st.paramDef(path))
  },
  compOfPath: (path,silent) =>
  	st.getComp(st.compNameOfPath(path,silent)),
  paramsOfPath: (path,silent) =>
  	jb.compParams(st.compOfPath(path,silent)), //.concat(st.compHeaderParams(path)),
  writeValueOfPath: (path,value,srcCtx) =>
		st.writeValue(st.refOfPath(path),value,srcCtx),
  getComp: id =>
		st.previewjb.comps[id],
  compAsStr: id =>
		jb.prettyPrintComp(id,st.getComp(id)),
});


// write operations with logic

Object.assign(st, {
	_delete: (path,srcCtx) => {
		var prop = path.split('~').pop();
		var parent = st.valOfPath(st.parentPath(path))
		if (Array.isArray(parent)) {
			var index = Number(prop);
			st.splice(st.refOfPath(st.parentPath(path)),[[index, 1]],srcCtx)
		} else {
			st.writeValueOfPath(path,null,srcCtx);
		}
	},

	wrapWithGroup: (path,srcCtx) =>
		st.writeValueOfPath(path,{ $: 'group', controls: [ st.valOfPath(path) ] },srcCtx),

	wrap: (path,compName,srcCtx) => {
		var comp = st.getComp(compName);
		var compositeParam = jb.compParams(comp).filter(p=>p.composite)[0];
		if (compositeParam) {
			var singleOrArray = compositeParam.type.indexOf('[') == -1 ? st.valOfPath(path) : [st.valOfPath(path)];
			if (jb.compParams(comp).length == 1) // use sugar
				var result = jb.obj('$'+compName,singleOrArray);
			else
				var result = Object.assign({ $: compName }, jb.obj(compositeParam.id,singleOrArray));
			st.writeValueOfPath(path,result,srcCtx);
		}
	},
	addProperty: (path,srcCtx) => {
		// if (st.paramTypeOfPath(path) == 'data')
		// 	return st.writeValueOfPath(path,'');
		var param = st.paramDef(path);
		var result = param.defaultValue || {$: ''};
		if (st.paramTypeOfPath(path).indexOf('data') != -1)
			result = '';
		if (param.type.indexOf('[') != -1)
			result = [];
		st.writeValueOfPath(path,result,srcCtx);
	},

	duplicateControl: (path,srcCtx) => {
		var prop = path.split('~').pop();
		var val = st.valOfPath(path);
		var parent_ref = st.getOrCreateControlArrayRef(st.parentPath(st.parentPath(path)));
		if (parent_ref) {
			var clone = st.evalProfile(jb.prettyPrint(val));
			st.splice(parent_ref,[[Number(prop), 0,clone]],srcCtx);
		}
	},
	duplicateArrayItem: (path,srcCtx) => {
		var prop = path.split('~').pop();
		var val = st.valOfPath(path);
		var parent_ref = st.refOfPath(st.parentPath(path));
		if (parent_ref && Array.isArray(st.val(parent_ref))) {
			var clone = st.evalProfile(jb.prettyPrint(val));
			st.splice(parent_ref,[[Number(prop), 0,clone]],srcCtx);
		}
	},
	disabled: path => {
		var prof = st.valOfPath(path);
		return prof && typeof prof == 'object' && prof.$disabled;
	},
	toggleDisabled: (path,srcCtx) => {
		var prof = st.valOfPath(path);
		if (prof && typeof prof == 'object' && !Array.isArray(prof))
			st.writeValue(st.refOfPath(path+'~$disabled'),prof.$disabled ? null : true,srcCtx)
	},
	setComp: (path,compName,srcCtx) => {
		var comp = compName && st.getComp(compName);
		if (!compName || !comp) return;
		var params = jb.compParams(comp);
		if (params.length == 1 && params[0].composite == true)
			return st.setSugarComp(path,compName,params[0],srcCtx);

		var result = comp.singleInType ? {} : { $: compName };
		params.forEach(p=>{
			if (p.composite)
				result[p.id] = [];
			if (p.defaultValue && typeof p.defaultValue != 'object')
				result[p.id] = p.defaultValue;
			if (p.defaultValue && typeof p.defaultValue == 'object' && (p.forceDefaultCreation || Array.isArray(p.defaultValue)))
				result[p.id] = JSON.parse(JSON.stringify(p.defaultValue));
		})
		var currentVal = st.valOfPath(path);
		if (!currentVal || typeof currentVal != 'object')
			st.writeValue(st.refOfPath(path),result,srcCtx)
		else
			st.merge(st.refOfPath(path),result,srcCtx);
	},

	setSugarComp: (path,compName,param,srcCtx) => {
		var emptyVal = (param.type||'').indexOf('[') == -1 ? '' : [];
		var currentVal = st.valOfPath(path);
		if (typeof currentVal == 'object') {
			var properties = Object.getOwnPropertyNames(currentVal);
			if (properties.length == 1 && properties[0].indexOf('$') == 0)
				currentVal = currentVal[properties[0]];
			else
				currentVal = st.valOfPath(path+'~'+param.id,true) || st.valOfPath(path+'~$'+compName,true);
		}
		if (currentVal && !Array.isArray(currentVal) && (param.type||'').indexOf('[') != -1)
			currentVal = [currentVal];
		st.writeValue(st.refOfPath(path),jb.obj('$'+compName,currentVal || emptyVal),srcCtx)
	},

	insertControl: (path,compName,srcCtx) => {
		var comp = compName && st.getComp(compName);
		if (!compName || !comp) return;
		var newCtrl = { $: compName };
		// copy default values
		jb.compParams(comp).forEach(p=>{
			if (p.defaultValue || p.defaultTValue)
				newCtrl[p.id] = JSON.parse(JSON.stringify(p.defaultValue || p.defaultTValue))
		})
		if (st.controlParams(path)[0] == 'fields')
			newCtrl = { $: 'field.control', control : newCtrl};
		// find group parent that can insert the control
		var group_path = path;
		while (st.controlParams(group_path).length == 0 && group_path)
			group_path = st.parentPath(group_path);
		var group_ref = st.getOrCreateControlArrayRef(group_path,srcCtx);
		if (group_ref)
			st.push(group_ref,[newCtrl],srcCtx);
	},
    // if dest is not an array item, fix it
   moveFixDestination(from,to,srcCtx) {
		if (isNaN(Number(to.split('~').slice(-1)))) {
            if (st.valOfPath(to) === undefined)
                jb.writeValue(st.refOfPath(to),[],srcCtx);
            to += '~' + st.valOfPath(to).length;
		}
		return jb.move(st.refOfPath(from),st.refOfPath(to),srcCtx)
	},

	addArrayItem: (path,toAdd,srcCtx) => {
		var val = st.valOfPath(path);
		var toAdd = toAdd || {$:''};
		if (Array.isArray(val)) {
			st.push(st.refOfPath(path),[toAdd],srcCtx);
//			return { newPath: path + '~' + (val.length-1) }
		}
		else if (!val) {
			st.writeValueOfPath(path,toAdd,srcCtx);
		} else {
			st.writeValueOfPath(path,[val].concat(toAdd),srcCtx);
//			return { newPath: path + '~1' }
		}
	},

	wrapWithArray: (path,srcCtx) => {
		var val = st.valOfPath(path);
		if (val && !Array.isArray(val))
			st.writeValueOfPath(path,[val],srcCtx);
	},

	makeLocal: (path,srcCtx) =>{
		var comp = st.compOfPath(path);
		if (!comp || typeof comp.impl != 'object') return;
		st.writeValueOfPath(path,st.evalProfile(jb.prettyPrint(comp.impl)),srcCtx);

		// var res = JSON.stringify(comp.impl, (key, val) => typeof val === 'function' ? ''+val : val , 4);
		//
		// var profile = st.valOfPath(path);
		// // inject conditional param values
		// jb.compParams(comp).forEach(p=>{
		// 		var pUsage = '%$'+p.id+'%';
		// 		var pVal = '' + (profile[p.id] || p.defaultValue || '');
		// 		res = res.replace(new RegExp('{\\?(.*?)\\?}','g'),(match,condition_exp)=>{ // conditional exp
		// 				if (condition_exp.indexOf(pUsage) != -1)
		// 					return pVal ? condition_exp : '';
		// 				return match;
		// 			});
		// });
		// // inject param values
		// jb.compParams(comp).forEach(p=>{
		// 		var pVal = '' + (profile[p.id] || p.defaultValue || ''); // only primitives
		// 		res = res.replace(new RegExp(`%\\$${p.id}%`,'g') , pVal);
		// });
		//
		// st.writeValueOfPath(path,st.evalProfile(res));
	},
	getOrCreateControlArrayRef: (path,srcCtx) => {
		var val = st.valOfPath(path);
		var prop = st.controlParams(path)[0];
		if (!prop)
			return console.log('getOrCreateControlArrayRef: no control param');
		var ref = st.refOfPath(path+'~'+prop);
		if (val[prop] === undefined)
			jb.writeValue(ref,[],srcCtx);
		else if (!Array.isArray(val[prop])) // wrap
			jb.writeValue(ref,[val[prop]],srcCtx);
		ref = st.refOfPath(path+'~'+prop);
		return ref;
	},
	evalProfile: prof_str => {
		try {
			return st.previewWindow.eval('('+prof_str+')')
		} catch (e) {
			jb.logException(e,'eval profile:'+prof_str);
		}
	},

  pathOfRef: ref =>
  		ref && ref.$jb_path && ref.$jb_path.join('~'),
	nameOfRef: ref =>
		(ref && ref.$jb_path) ? ref.$jb_path.slice(-1)[0].split(':')[0] : 'ref',
	valSummaryOfRef: ref =>
		st.valSummary(jb.val(ref)),
	valSummary: val => {
		if (val && typeof val == 'object')
			return val.id || val.name
		return '' + val;
	},
	pathSummary: path =>
		path.replace(/~controls~/g,'~').replace(/~impl~/g,'~').replace(/^[^\.]*./,''),
	isPrimitiveValue: val => ['string','boolean','number'].indexOf(typeof val) != -1,
})

// ******* components ***************

jb.component('studio.ref', {
	params: [ {id: 'path', as: 'string', essential: true } ],
	impl: (ctx,path) =>
		st.refOfPath(path)
});

jb.component('studio.path-of-ref', {
	params: [ {id: 'ref', defaultValue: '%%', essential: true } ],
	impl: (ctx,ref) =>
		st.pathOfRef(ref)
});

jb.component('studio.name-of-ref', {
	params: [ {id: 'ref', defaultValue: '%%', essential: true } ],
	impl: (ctx,ref) =>
		st.nameOfRef(ref)
});


jb.component('studio.is-new', {
	type: 'boolean',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) => {
		if (st.compsHistory.length == 0 || st.previewjb.comps.$jb_selectionPreview) return false;
		var version_before = new jb.ui.ImmutableWithPath(_=>st.compsHistory.slice(-1)[0].before).refOfPath(path.split('~'),true);
		var res =  JSON.stringify(st.valOfPath(path)) != JSON.stringify(st.val(version_before));
//		var res =  st.valOfPath(path) && !st.val(version_before);
		return res;
	}
});

jb.component('studio.watch-path', {
  type: 'feature',
  category: 'group:0',
  params: [
    { id: 'path', as: 'string', essential: true },
    { id: 'includeChildren', as: 'boolean' },
  ],
  impl: (ctx,path,includeChildren) => ({
      init: cmp =>
      	jb.ui.watchRef(ctx,cmp,st.refOfPath(path),includeChildren)
  })
})

jb.component('studio.watch-script-changes', {
  type: 'feature',
  impl: ctx => ({
      init: cmp =>
        st.compsRefHandler.resourceChange.debounceTime(200).subscribe(e=>
            jb.ui.setState(cmp,null,e,ctx))
   })
})

jb.component('studio.watch-components', {
  type: 'feature',
  impl: ctx => ({
      init: cmp =>
        st.compsRefHandler.resourceChange.filter(e=>e.path.length == 1)
        	.subscribe(e=>
            	jb.ui.setState(cmp,null,e,ctx))
   })
})


jb.component('studio.watch-typeof-script', {
  params: [
    { id: 'path', as: 'string', essential: true },
  ],
  type: 'feature',
  impl: (ctx,path) => ({
      init: cmp =>
    	jb.ui.refObservable(st.refOfPath(path),cmp,{ includeChildren: true})
    		.filter(e=>
    			(typeof e.oldVal == 'object') != (typeof e.newVal == 'object'))
    		.subscribe(e=>
        		jb.ui.setState(cmp,null,e,ctx))
   })
})

jb.component('studio.path-hyperlink', {
  type: 'control',
  params: [
    { id: 'path', as: 'string', essential: true },
    { id: 'prefix', as: 'string' }
  ],
  impl :{$: 'group',
    style :{$: 'layout.horizontal', spacing: '9' },
    controls: [
      {$: 'label', title: '%$prefix%' },
      {$: 'button',
        title: ctx => {
	  		var path = ctx.componentContext.params.path;
	  		var title = st.shortTitle(path) || '',compName = st.compNameOfPath(path) || '';
	  		return title == compName ? title : compName + ' ' + title;
	  	},
        action :{$: 'studio.goto-path', path: '%$path%' },
        style :{$: 'button.href' },
        features :{$: 'feature.hover-title', title: '%$path%' }
      }
    ]
  }
})

})()
;

jb.resource('studio',{});

jb.component('studio.all', {
  type: 'control',
  impl :{$: 'group',
    controls: [
      {$: 'studio.top-bar' },
      {$: 'studio.preview-widget',
        features :{$: 'watch-ref', ref: '%$studio/page%' },
        width: 1280,
        height: 520
      },
      {$: 'studio.pages' },
      {$: 'studio.ctx-counters' },
    ],
    features: [
      {$: 'group.data', data: '%$studio/project%', watch: true },
      {$: 'feature.init',
        action: [
          {$: 'url-history.map-url-to-resource',
            params: ['project', 'page', 'profile_path'],
            resource: 'studio',
            base: 'studio'
          }
        ]
      }
    ]
  }
})

jb.component('studio.top-bar', {
  type: 'control',
  impl :{$: 'group',
    title: 'top bar',
    style :{$: 'layout.horizontal', spacing: '3' },
    controls: [
      {$: 'image',
        url: '/projects/studio/css/jbartlogo.png',
        imageHeight: '60',
        units: 'px',
        style :{$: 'image.default' },
        features :{$: 'css.margin', top: '15', left: '5' }
      },
      {$: 'group',
        title: 'title and menu',
        style :{$: 'layout.vertical', spacing: '17' },
        controls: [
          {$: 'label',
            title: 'message',
            style :{$: 'label.studio-message' }
          },
          {$: 'label',
            title :{$: 'replace', find: '_', replace: ' ', text: '%$studio/project%' },
            style :{$: 'label.span' },
            features :{$: 'css', css: '{ font: 20px Arial; margin-left: 6px; }' }
          },
          {$: 'group',
            title: 'menu and toolbar',
            style :{$: 'layout.flex', align: 'space-between' },
            controls: [
              {$: 'menu.control',
                menu :{$: 'studio.main-menu' },
                style :{$: 'menu-style.pulldown' },
                features :{$: 'css.height', height: '30' }
              },
              {$: 'studio.toolbar' },
              {$: 'studio.search-component',
                features :{$: 'css.margin', top: '-10' }
              }
            ],
            features: [{$: 'css.width', width: '1040' }]
          }
        ],
        features :{$: 'css', css: '{ padding-left: 18px; width: 100%; }' }
      }
    ],
    features :{$: 'css', css: '{ height: 90px; border-bottom: 1px #d9d9d9 solid}' }
  }
})

jb.component('studio.pages', {
  type: 'control',
  impl :{$: 'group',
    title: 'pages',
    style :{$: 'layout.horizontal' },
    controls: [
      {$: 'button',
        title: 'new page',
        action :{$: 'studio.open-new-page' },
        style :{$: 'button.mdl-icon-12', icon: 'add' },
        features :{$: 'css', css: '{margin: 5px}' }
      },
      {$: 'itemlist',
        items :{$: 'studio.project-pages' },
        controls :{$: 'label',
          title :{$: 'extract-suffix', separator: '.' },
          features :{$: 'css.class', class: 'studio-page' }
        },
        style :{$: 'itemlist.horizontal' },
        features: [
          {$: 'itemlist.selection',
            databind: '%$studio/page%',
            onSelection :{$: 'write-value',
              to: '%$studio/profile_path%',
              value: '{%$studio/project%}.{%$studio/page%}'
            },
            autoSelectFirst: true
          },
          {$: 'css',
            css: `{ list-style: none; padding: 0;
              margin: 0; margin-left: 20px; font-family: "Arial"}
                  >* { list-style: none; display: inline-block; padding: 0 5px; font-size: 12px; border: 1px solid transparent; cursor: pointer;}
                  >* label { cursor: inherit; }
                  >*.selected { background: #fff;  border: 1px solid #ccc;  border-top: 1px solid transparent; color: inherit;  }`
          }
        ]
      }
    ],
    features: [
      {$: 'css',
        css: '{ background: #F5F5F5; position: absolute; bottom: 0; left: 0; width: 100%; border-top: 1px solid #aaa}'
      },
      {$: 'group.wait',
        for :{$: 'studio.wait-for-preview-iframe' },
        loadingControl :{ $label: '...' }
      },
      {$: 'studio.watch-components' }
    ]
  }
})

jb.component('studio.ctx-counters', {
  type: 'control',
  impl :{$: 'label',
    title: ctx => Math.floor(100 * performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) + '% memory',
    //jb.ctxCounter() + '/' + jb.studio.previewjb.ctxCounter(),
    features: [
      {$: 'css',
        css: '{ background: #F5F5F5; position: absolute; bottom: 0; right: 0; }'
      },
      {$: 'watch-observable', $trace1: true,
        toWatch: ctx => jb.studio.compsRefHandler.resourceChange.debounceTime(500)
      }
    ]
  }
})

jb.component('studio.currentProfilePath', {
	impl: { $firstSucceeding: [ '%$simulateProfilePath%','%$studio/profile_path%', '%$studio/project%.%$studio/page%'] }
})

jb.component('studio.is-single-test', {
	type: 'boolean',
	impl: ctx => {
		var page = location.href.split('/')[6];
		var profile_path = location.href.split('/')[7];
		return page == 'tests' && profile_path && profile_path.slice(-6) != '.tests';
  	}
})

jb.component('studio.cmps-of-project', {
  type: 'data',
  params: [
    { id: 'project', as: 'string'}
  ],
  impl: (ctx,prj) =>
      jb.studio.previewjb ? Object.getOwnPropertyNames(jb.studio.previewjb.comps)
              .filter(id=>id.split('.')[0] == prj) : []
})

jb.component('studio.project-pages', {
	type: 'data',
  impl: {$pipeline: [
          {$: 'studio.cmps-of-project', project: '%$studio/project%' },
          { $filter: {$: 'studio.is-of-type', type: 'control', path: '%%'} },
          {$: 'suffix', separator: '.' }
      ]}
})

jb.component('studio.main-menu', {
  type: 'menu.option', 
  impl :{$: 'menu.menu', 
    style :{$: 'menu.pulldown' }, 
    features :{$: 'css.margin', top: '3' }, 
    title: 'main', 
    options: [
      {$: 'menu.menu', 
        title: 'File', 
        options: [
          {$: 'menu.action', 
            title: 'New Project', 
            action :{$: 'studio.open-new-project' }, 
            icon: 'new'
          }, 
          {$: 'menu.action', 
            title: 'Open Project ...', 
            action :{$: 'studio.open-project' }
          }, 
          {$: 'menu.action', 
            title: 'Save', 
            action :{$: 'studio.save-components' }, 
            icon: 'save', 
            shortcut: 'Ctrl+S'
          }, 
          {$: 'menu.action', 
            title: 'Force Save', 
            action :{$: 'studio.save-components', force: true }, 
            icon: 'save'
          }, 
          {$: 'menu.action', 
            title: 'Source ...', 
            action :{$: 'studio.open-source-dialog' }
          }
        ]
      }, 
      {$: 'menu.menu', 
        title: 'View', 
        options: [
          {$: 'menu.action', 
            title: 'Refresh Preview', 
            action :{$: 'studio.refresh-preview' }
          }, 
          {$: 'menu.action', 
            title: 'Redraw Studio', 
            action :{$: 'studio.redraw-studio' }
          }, 
          {$: 'menu.action', 
            title: 'Edit source', 
            action :{$: 'studio.edit-source' }
          }, 
          {$: 'menu.action', 
            title: 'Outline', 
            action :{$: 'studio.open-control-tree' }
          }, 
          {$: 'menu.action', 
            title: 'jbEditor', 
            action :{$: 'studio.openjbEditor' }
          }, 
          {$: 'menu.action', 
            title: 'Disable probe', 
            action: ctx => jb.studio.probeDisabled = true, 
            showCondition: ctx => !jb.studio.probeDisabled
          }, 
          {$: 'menu.action', 
            title: 'Enable probe', 
            action: ctx => jb.studio.probeDisabled = false, 
            showCondition: ctx => jb.studio.probeDisabled
          }
        ]
      }, 
      {$: 'studio.insert-control-menu' }, 
      {$: 'studio.data-resource-menu' }
    ]
  }
})
;

jb.component('studio.pickAndOpen', {
	type: 'action',
	params: [
		{ id: 'from', options: 'studio,preview', as: 'string', defaultValue: 'preview'}
	],
	impl :{$: 'studio.pick',
		from: '%$from%',
	  	onSelect: [
      {$: 'write-value', to: '%$studio/last_pick_selection%', value: '%%' },
      {$: 'write-value', to: '%$studio/profile_path%', value: '%path%' },
			{$: 'studio.open-control-tree'},
      {$: 'studio.open-properties'},
 		],
	}
})

jb.component('studio.toolbar', {
  type: 'control', 
  impl :{$: 'group', 
    style :{$: 'studio-toolbar' }, 
    controls: [
      {$: 'label', 
        title: '', 
        features :{$: 'css', css: '{ width: 170px }' }
      }, 
      {$: 'button', 
        title: 'Select', 
        action :{$: 'studio.pickAndOpen' }, 
        style :{$: 'button.mdl-icon', 
          features :{$: 'css', css: '{transform: scaleX(-1)}' }, 
          icon: 'call_made'
        }
      }, 
      {$: 'button', 
        title: 'Save', 
        action :{$: 'studio.save-components' }, 
        style :{$: 'button.mdl-icon', icon: 'save' }, 
        features :{$: 'ctrl-action', 
          action :{$: 'studio.save-components', force: true }
        }
      }, 
      {$: 'button', 
        title: 'Refresh Preview', 
        action :{$: 'studio.refresh-preview' }, 
        style :{$: 'button.mdl-icon', icon: 'refresh' }
      }, 
      {$: 'button', 
        title: 'Javascript', 
        action :{$: 'studio.edit-source' }, 
        style :{$: 'button.mdl-icon', icon: 'code' }
      }, 
      {$: 'button', 
        title: 'Outline', 
        action :{$: 'studio.open-control-tree' }, 
        style :{$: 'button.mdl-icon', icon: 'format_align_left' }
      }, 
      {$: 'button', 
        title: 'Properties', 
        action :{$: 'studio.open-properties', focus: 'true' }, 
        style :{$: 'button.mdl-icon', icon: 'storage' }
      }, 
      {$: 'button', 
        title: 'jbEditor', 
        action :{$: 'studio.open-component-in-jb-editor', 
          path: '%$studio/project%.%$studio/page%'
        }, 
        style :{$: 'button.mdl-icon', icon: 'build' }, 
        features :{$: 'ctrl-action', 
          action :{$: 'studio.open-jb-editor', 
            path: '%$studio/profile_path%', 
            newWindow: true
          }
        }
      }, 
      {$: 'button', 
        title: 'Event Tracker', 
        action :{$: 'studio.open-event-tracker' }, 
        style :{$: 'button.mdl-icon', icon: 'hearing' }, 
        features :{$: 'ctrl-action', 
          action :{$: 'studio.open-event-tracker', studio: 'true' }
        }
      }, 
      {$: 'button', 
        title: 'History', 
        action :{$: 'studio.open-script-history' }, 
        style :{$: 'button.mdl-icon', icon: 'pets' }
      }, 
      {$: 'button', 
        title: 'Show Data', 
        action :{$: 'studio.showProbeData' }, 
        style :{$: 'button.mdl-icon', icon: 'input' }
      }, 
      {$: 'button', 
        title: 'Insert Control', 
        action :{$: 'studio.open-new-profile-dialog', 
          type: 'control', 
          mode: 'insert-control'
        }, 
        style :{$: 'button.mdl-icon', icon: 'add' }
      }, 
      {$: 'button', 
        title: 'Responsive', 
        action :{$: 'studio.open-responsive-phone-popup' }, 
        style :{$: 'button.mdl-icon', icon: 'tablet_android' }
      }
    ], 
    features: [
      {$: 'feature.keyboard-shortcut', 
        key: 'Alt+C', 
        action :{$: 'studio.pickAndOpen' }
      }, 
      {$: 'feature.keyboard-shortcut', 
        key: 'Alt++', 
        action :{$: 'studio.open-new-profile-dialog', 
          type: 'control', 
          mode: 'insert-control'
        }
      }, 
      {$: 'feature.keyboard-shortcut', 
        key: 'Alt+N', 
        action :{$: 'studio.pickAndOpen', from: 'studio' }
      }, 
      {$: 'feature.keyboard-shortcut', 
        key: 'Alt+X', 
        action :{$: 'studio.open-jb-editor', 
          path :{
            $firstSucceeding: ['%$studio/profile_path%', '%$studio/project%.%$studio/page%']
          }
        }
      }
    ]
  }
})

jb.component('studio_button.toolbarButton', {
	type: 'button.style',
	params: [
		{ id: 'spritePosition', as: 'string', defaultValue: '0,0' }
	],
	impl: (ctx, spritePosition) => ({
			template: (cmp,state,h) => h('button',{class: 'studio-btn-toolbar', click: _=> cmp.clicked() },
          h('span', {title: state.title, style: { 'background-position': state.pos} })),
			init: cmp =>
				cmp.state.pos = spritePosition.split(',').map(item => (-parseInt(item) * 16) + 'px').join(' '),
	})
})

jb.component('studio-toolbar', {
  type: 'group.style',
  impl :{$: 'custom-style',
    features :{$: 'group.init-group' },
    template: (cmp,state,h) => h('section',{class:'jb-group'},
        state.ctrls.map(ctrl=> jb.ui.item(cmp,h(ctrl),ctrl.ctx))),
    css: `{
            display: flex;
            height: 33px;
            width: 100%;
        }
        >*:not(:last-child) { padding-right: 8px }
        >* { margin-right: 0 }`
  }
})
;

jb.component('editable-text.studio-primitive-text', {
  type: 'editable-text.style',
  impl :{$: 'custom-style',
      features :{$: 'field.databind-text' },
      template: (cmp,state,h) => h('input', {
          class: 'mdl-textfield__input',
          value: state.model,
          onchange: e => cmp.jbModel(e.target.value),
          onkeyup: e => cmp.jbModel(e.target.value,'keyup')
      }),
    css: `{ width: 367px} :focus { border-color: #3F51B5; border-width: 2px}`,
	}
})

jb.component('button.select-profile-style', {
  type: 'button.style',
  impl :{$: 'custom-style',
   template: (cmp,state,h) =>
        h('input', { class: 'mdl-textfield__input', type: 'text', readonly: true, title: state.title,
            value: state.title,
            onmouseup:ev => cmp.clicked(ev),
            onkeydown:ev => ev.keyCode == 13 && cmp.clicked(ev),
        }),
        css: `{ cursor: pointer;width: 367px } :focus { border-color: #3F51B5; border-width: 2px}`
  }
})

jb.component('studio.property-toolbar-style', {
  type: 'button.style',
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('i',{class: 'material-icons',
        onclick: ev => cmp.clicked(ev)
      },'more_vert'),
      css: `{ cursor: pointer;width: 16px; font-size: 16px; padding-top: 3px }`,
  }
})


jb.component('editable-text.jb-editor-floating-input', {
  type: 'editable-text.style',
  impl :{$: 'custom-style',
   template: (cmp,state,h) => h('div',{class:'mdl-textfield mdl-js-textfield mdl-textfield--floating-label'},[
        h('input', { class: 'mdl-textfield__input', id: 'jb_input_' + state.fieldId, type: 'text',
            value: state.model,
            onchange: e => cmp.jbModel(e.target.value),
            onkeyup: e => cmp.jbModel(e.target.value,'keyup'),
        }),
        h('label',{class: 'mdl-textfield__label', for: 'jb_input_' + state.fieldId},state.title)
      ]),
      css: '{ margin-right: 13px; }', // for the x-button
      features :[
          {$: 'field.databind-text', debounceTime: 300, oneWay: true },
          {$: 'mdl-style.init-dynamic'}
      ],
  }
})

jb.component('button.studio-script', {
  type: 'button.style',
  impl :{$: 'custom-style',
   template: (cmp,state,h) =>
        h('input', { class: 'mdl-textfield__input', type: 'text', readonly: true, title: state.title,
            value: state.title,
            onmouseup:ev => cmp.clicked(ev),
            onkeydown:ev => ev.keyCode == 13 && cmp.clicked(ev),
        }),
        css: `{ cursor: pointer;width: 367px; opacity: 0.8; font-style: italic; }`
  }
})

// jb.component('button.studio-script2', {
//   type: 'button.style',
//   impl :{$: 'custom-style',
//       template: (cmp,state,h) => h('div', { title: state.title, onclick: _ => cmp.clicked() },
//         h('div',{class:'inner-text'},state.title)),
//           css: `>.inner-text {
//   white-space: nowrap; overflow-x: hidden;
//   display: inline; height: 16px;
//   padding-left: 4px; padding-top: 2px;
//   font: 12px "arial"; color: #555555;
// }

// {
//   width: 149px;
//   border: 1px solid #ccc; border-radius: 4px;
//   cursor: pointer;
//   box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075);
//   background: #eee;
//   white-space: nowrap; overflow-x: hidden;
//   text-overflow: ellipsis;
// }`,
// }
// })


// todo: take from http://creativeit.github.io/getmdl-select/
 // <div class="mdl-textfield mdl-js-textfield mdl-textfield--floating-label getmdl-select getmdl-select__fullwidth">
 //            <input class="mdl-textfield__input" type="text" id="sample1" value="Belarus" readonly tabIndex="-1">
 //            <label for="sample1" class="mdl-textfield__label">Country</label>
 //            <ul for="sample1" class="mdl-menu mdl-menu--bottom-left mdl-js-menu">
 //                <li class="mdl-menu__item">Germany</li>
 //                <li class="mdl-menu__item">Belarus</li>
 //                <li class="mdl-menu__item">Russia</li>
 //            </ul>
 //        </div>

jb.component('picklist.studio-enum', {
  type: 'picklist.style',
  impl :{$: 'custom-style',
      features :{$: 'field.databind' },
      template: (cmp,state,h) => h('select', { value: state.model, onchange: e => cmp.jbModel(e.target.value) },
          state.options.map(option=>h('option',{value: option.code},option.text))
        ),
    css: `
{ display: block; padding: 0; width: 150px; font-size: 12px; height: 23px;
	color: #555555; background-color: #fff;
	border: 1px solid #ccc; border-radius: 4px;
	box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075);
	transition: border-color ease-in-out 0.15s, box-shadow ease-in-out 0.15s;
}
:focus { border-color: #66afe9; outline: 0;
	box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075), 0 0 8px rgba(102, 175, 233, 0.6); }
::placeholder { color: #999; opacity: 1; }
    `
  }
})


jb.component('property-sheet.studio-properties', {
  type: 'group.style',
  impl :{$: 'custom-style',
    features :{$: 'group.init-group' },
    template: (cmp,state,h) => h('table',{}, state.ctrls.map(ctrl=>
      h('tr',{ class: 'property' },[
          h('td',{ class: 'property-title', title: ctrl.title}, ctrl.title),
          h('td',{ class: 'property-ctrl'},h(ctrl)),
          h('td',{ class: 'property-toolbar'}, h(ctrl.jbComp.toolbar) ),
      ])
    )),
    css: `
      { width: 100% }
      >.property>.property-title { width: 90px; padding-right: 5px; padding-top: 5px }
      >.property>td { vertical-align: top; }
    `,
  }
})

jb.component('property-sheet.studio-properties-in-tgp', {
  type: 'group.style',
  impl :{$: 'custom-style',
    features :{$: 'group.init-group' },
    template: (cmp,state,h) => h('table',{}, state.ctrls.map(ctrl=>
      h('tr',{ class: 'property' },[
          h('td',{ class: 'property-title', title: ctrl.title}, ctrl.title),
          h('td',{ class: 'property-ctrl'},h(ctrl)),
          h('td',{ class: 'property-toolbar'}, h(ctrl.jbComp.toolbar) ),
      ])
    )),
    css: `
      { width: 100% }
      >.property>.property-title { width: 90px; padding-right: 5px; padding-top: 5px }
      >.property>.property-ctrl { }
      >.property>td { vertical-align: top; }
    `,

    css2: `>.property { margin-bottom: 5px; display: flex }
      >.property:last-child { margin-bottom:0px }
      >.property>.input-and-toolbar { display: flex; }
      >.property>.input-and-toolbar>.toolbar { height: 16px; margin-left: 10px; }
      >.property>.property-title {
        width: 75px;
        overflow:hidden;
        text-overflow:ellipsis;
        vertical-align:top;
        margin-top:2px;
        font-size:14px;
        margin-right: 10px;
        margin-left: 7px;
      },
      >.property>*:last-child { margin-right:0 }`
  }
})


jb.component('property-sheet.studio-plain', {
  type: 'group.style',
  impl :{$: 'custom-style',
    features :{$: 'group.init-group' },
    template: (cmp,state,h) => h('div',{}, state.ctrls.map(ctrl=>
      h('div',{ class: 'property' },[
          h('label',{ class: 'property-title', title: ctrl.title}, ctrl.title),
          h('div',{ class: 'input-and-toolbar'}, [
            h(ctrl),
            h(ctrl.jbComp.toolbar)
          ])
    ]))),
    css: `>.property { margin-bottom: 5px; display: flex }
      >.property:last-child { margin-bottom:0px }
      >.property>.input-and-toolbar { display: flex; }
      >.property>.input-and-toolbar>.toolbar { height: 16px; margin-left: 10px }
      >.property>.property-title {
        min-width: 90px;
        width: 90px;
        overflow:hidden;
        text-overflow:ellipsis;
        vertical-align:top;
        margin-top:2px;
        font-size:14px;
        margin-right: 10px;
        margin-left: 7px;
      },
      >.property>*:last-child { margin-right:0 }`
  }
})

jb.component('editable-boolean.studio-expand-collapse-in-toolbar', {
  type: 'editable-boolean.style',
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('button',{class: 'md-icon-button md-button',
          onclick: _=> cmp.toggle(),
          title: cmp.jbModel() ? 'collapse' : 'expand'},
            h('i',{class: 'material-icons'}, cmp.jbModel() ? 'keyboard_arrow_down' : 'keyboard_arrow_right')
          ),
      css: `{ width: 24px; height: 24px; padding: 0; margin-top: -3px;}
     	>i { font-size:12px;  }`
   }
})

jb.component('editable-boolean.studio-expand-collapse-in-array', {
  type: 'editable-boolean.style',
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('button',{class: 'md-icon-button md-button',
          onclick: _=> cmp.toggle(),
          title: cmp.jbModel() ? 'collapse' : 'expand'},
            h('i',{class: 'material-icons'}, cmp.jbModel() ? 'keyboard_arrow_down' : 'keyboard_arrow_right')
          ),
      css: `{ width: 24px; height: 24px; padding: 0; }
     	>i { font-size:12px;  }
      `
   }
})


jb.component('dialog.studio-multiline-edit',{
	type: 'dialog.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('div',{ class: 'jb-dialog jb-popup'},[
      h('button',{class: 'dialog-close', onclick:
        _=> cmp.dialogClose() },'×'),
      h(state.contentComp),
    ]),
			css: `{ background: #fff; position: absolute; min-width: 280px; min-height: 200px;
					box-shadow: 2px 2px 3px #d5d5d5; padding: 3px; border: 1px solid rgb(213, 213, 213)
				  }
				>.dialog-close {
						position: absolute;
						cursor: pointer;
						right: -7px; top: -22px;
						font: 21px sans-serif;
						border: none;
						background: transparent;
						color: #000;
						text-shadow: 0 1px 0 #fff;
						font-weight: 700;
						opacity: .2;
				}
				>.dialog-close:hover { opacity: .5 }
				`,
			features: [
				{ $: 'dialog-feature.max-zIndex-on-click' },
				{ $: 'dialog-feature.close-when-clicking-outside' },
				{ $: 'dialog-feature.css-class-on-launching-element' },
				{ $: 'dialog-feature.studio-position-under-property' }
			]
	}
})

jb.component('dialog-feature.studio-position-under-property', {
	type: 'dialog-feature',
	impl: (context,offsetLeft,offsetTop) => ({
			afterViewInit: function(cmp) {
				if (!context.vars.$launchingElement)
					return console.log('no launcher for dialog');
				var control = jb.ui.parents(context.vars.$launchingElement.el).filter(el=>jb.ui.matches(el,'.input-and-toolbar'));
				var pos = jb.ui.offset(control);
				var jbDialog = jb.ui.findIncludeSelf(cmp.base,'.jb-dialog')[0];
        if (jbDialog) {
  				jbDialog.style.left = `${pos.left}px`;
          jbDialog.style.top = `${pos.top}px`;
          jbDialog.style.display = 'block';
        }
			}
		})
})

jb.component('group.studio-properties-accordion', {
  type: 'group.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('section',{ class: 'jb-group'},
        state.ctrls.map((ctrl,index)=> jb.ui.item(cmp,h('div',{ class: 'accordion-section' },[
          h('div',{ class: 'header', onclick: _=> cmp.show(index) },[
            h('div',{ class: 'title'}, ctrl.title),
            h('button',{ class: 'mdl-button mdl-button--icon', title: cmp.expand_title(ctrl) },
              h('i',{ class: 'material-icons'}, state.shown == index ? 'keyboard_arrow_down' : 'keyboard_arrow_right')
            )
          ])].concat(state.shown == index ? [h(ctrl)] : [])),ctrl.ctx.data)
    )),
    css: `>.accordion-section>.header { cursor: pointer; display: flex; flex-direction: row; background: #eee; margin-bottom: 2px; justify-content: space-between}
>.accordion-section>.header>button:hover { background: none }
>.accordion-section>.header>button { margin-left: auto }
>.accordion-section>.header>button>i { color: #; cursor: pointer }
>.accordion-section>.header>.title { margin: 5px }
>.accordion-section:last-child() { padding-top: 2px }
`,
      features : [
        {$: 'group.init-group' },
        {$: 'group.init-accordion', keyboardSupport: true, autoFocus: true },
        ctx =>({
          afterViewInit: cmp =>
            ctx.vars.PropertiesDialog.openFeatureSection = _ => cmp.show(1)
        })
      ]
  }
})

jb.component('label.studio-message', {
  type: 'label.style',
  impl :{$: 'custom-style',
    template: (cmp,state,h) => h('span',{class: 'studio-message'}, state.title),
    css: `{ position: absolute;
      color: white;  padding: 10px;  background: #327DC8;
      width: 1000px;
      margin-top: -100px;
      }`,
    features: {$: 'label.bind-title' }
  }
})
;


jb.component('studio.search-component', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'group',
    title: 'itemlist-with-find',
    style :{$: 'layout.horizontal', spacing: '' },
    controls: [
      {$: 'itemlist-container.search',
        control :{$: 'studio.search-list', path: '%$path%' },
        title: 'Search',
        searchIn: item =>
          item.id,
        databind: '%$itemlistCntrData/search_pattern%',
        style :{$: 'editable-text.mdl-input', width: '200' },
        features: [
          {$: 'editable-text.helper-popup',
            features :{$: 'dialog-feature.near-launcher-position' },
            control :{$: 'studio.search-list' },
            popupId: 'search-component',
            popupStyle :{$: 'dialog.popup' }
          }
        ]
      }
    ],
    features: [
      {$: 'group.itemlist-container' },
      {$: 'css.margin', top: '-13' }
    ]
  }
})

jb.component('studio.search-list', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'group',
    controls: [
      {$: 'table',
        items :{
          $pipeline: [
            {$: 'studio.components-cross-ref' },
            {$: 'itemlist-container.filter' },
            {$: 'sort', propertyName: 'refCount' },
            {$: 'slice', start: '0', end: '50' }
          ]
        },
        fields: [
          {$: 'field.control',
            control :{$: 'material-icon',
              icon :{$: 'studio.icon-of-type', type: '%type%' },
              features: [
                {$: 'css.opacity', opacity: '0.3' },
                {$: 'css', css: '{ font-size: 16px }' },
                {$: 'css.padding', top: '5', left: '5' }
              ]
            }
          },
          {$: 'field.control',
            title: 'id',
            control :{$: 'button',
              title :{$: 'pipeline',
                items :{$: 'highlight',
                  base: '%id%',
                  highlight: '%$itemlistCntrData/search_pattern%',
                  cssClass: 'mdl-color-text--indigo-A700'
                }
              },
              action :{$: 'studio.goto-path', path: '%id%' },
              style :{$: 'button.href' }
            },
            width: '200'
          },
          {$: 'field.control',
            title: 'refs',
            control :{$: 'button',
              icon :{$: 'studio.icon-of-type', type: '%type%' },
              title: '%refCount%',
              action :{$: 'menu.open-context-menu',
                menu :{$: 'menu.menu',
                  options: [
                    {$: 'studio.goto-references-options',
                      path: '%id%',
                      refs :{$: 'studio.references', path: '%id%' }
                    }
                  ]
                },
              },
              style :{$: 'button.href' }
            }
          },
          {$: 'field', title: 'type', data: '%type%' },
          {$: 'field',
            title: 'impl',
            data :{$: 'pipeline',
              items: [
                '%implType%',
                {$: 'data.if',
                  condition: '%% = "function"',
                  then: 'javascript',
                  else: ''
                }
              ]
            }
          }
        ],
        style :{$: 'table.with-headers' },
        features: [{$: 'watch-ref', ref: '%$itemlistCntrData/search_pattern%' }]
      }
    ],
    features: [
      {$: 'css.box-shadow', shadowColor: '#cccccc' },
      {$: 'css.padding', top: '4', right: '5' },
      {$: 'css.height', height: '600', overflow: 'auto', minMax: 'max' },
      {$: 'css.width', width: '400', minMax: 'min' }
    ]
  }
})

jb.component('studio.search-component-selected',{
  type: 'action',
  params: [
    {id: 'path', as: 'string'}
  ],
  impl: {$runActions: [
    {$: 'write-value', to: '%$itemlistCntrData/search_pattern%', value: '' },
    {$: 'studio.goto-path', path: '%$path%' },
    {$: 'dialog.close-containing-popup' }
  ]}
})
;

jb.component('studio.open-new-profile-dialog', {
  type: 'action',
  params: [
    {
      id: 'path',
      as: 'string',
      defaultValue :{$: 'studio.currentProfilePath' }
    },
    { id: 'type', as: 'string' },
    {
      id: 'mode',
      option: 'insert,insert-control,update',
      defaultValue: 'insert'
    },
    { id: 'onClose', type: 'action', dynamic: true }
  ],
  impl :{$: 'open-dialog',
    style :{$: 'dialog.studio-floating' },
    content :{$: 'studio.select-profile',
      onSelect :{$: 'action.if',
        condition: '%$mode% == "insert-control"',
        then: {$: 'studio.insert-control', path: '%$path%', comp: '%%' },
        else :{
          $if: '%$mode% == "insert"',
          then :{$: 'studio.add-array-item',
            path: '%$path%',
            toAdd :{
              $object :{$: '%%' }
            }
          },
          else :{$: 'studio.set-comp', path: '%$path%', comp: '%%' }
        }
      },
      type: '%$type%',
      path: '%$path%'
    },
    title: 'new %$type%',
    features: [
      {$: 'css.height', height: '430', overflow: 'hidden' },
      {$: 'css.width', width: '450', overflow: 'hidden' },
      {$: 'dialog-feature.drag-title', id: 'new %$type%' },
      {$: 'dialog-feature.near-launcher-position', offsetLeft: 0, offsetTop: 0 },
      {$: 'dialog-feature.auto-focus-on-first-input' },
//			{$: 'var', name: 'initial-comps-index', value: {$: 'studio.comps-undo-index'}},
      {$: 'dialog-feature.onClose',
        action : [
					{ $if: {$not:'%%'},
	//					then: {$: 'studio.revert', toIndex: '%$initial-comps-index%' },
						else: [ {$:'studio.goto-last-edit'}, {$: 'studio.focus-on-first-property'}]
					},
					{ $call: 'onClose' }
				]
      }
    ]
  }
})

jb.component('studio.categories-marks', {
  params: [
    { id: 'type', as: 'string' },
    { id: 'path', as: 'string' },
  ],
  impl :{$: 'pipeline',
    items: [
        { $: 'object' ,
          control :{$: 'pipeline',
            items: [
              {$: 'list',
                items: [
                  'common:100',
                  'control:95',
                  'input:90',
                  'group:85',
                  'studio-helper:0,suggestions-test:0,studio:0,test:0,basic:0,ui-tests:0,studio-helper-dummy:0,itemlist-container:0'
                ]
              },
              {$: 'split', separator: ',' },
              {$: 'object',
                code: {$: 'split', separator: ':', part: 'first'  },
                mark: {$: 'split', separator: ':', part: 'second'  },
              }
            ]
          },
          feature :{$: 'pipeline',
            items: [
              {$: 'list',
                items: [
                  'css:100',
                  'watch:95',
									'lifecycle:90',
                  'events:85',
									'group:80',
									'all:20',
                  'feature:0,tabs:0,label:0,picklist:0,mdl:0,studio:0,text:0,menu:0,flex-layout-container:0,mdl-style:0,itemlist-container:0,editable-text:0,editable-boolean:0',
                  'mdl-style:0'
                ]
              },
              {$: 'split', separator: ',' },
              {$: 'object',
                code: {$: 'split', separator: ':', part: 'first'  },
                mark: {$: 'split', separator: ':', part: 'second'  },
              }
            ]
          },
		  'group.style' :{$: 'pipeline',
            items: [
              {$: 'list',
                items: [
                  'layout:100',
                  'group:90',
                  'tabs:0',
                ]
              },
              {$: 'split', separator: ',' },
              {$: 'object',
                code: {$: 'split', separator: ':', part: 'first'  },
                mark: {$: 'split', separator: ':', part: 'second'  },
              }
            ]
          },
        },
       {$firstSucceeding: [ ctx => ctx.data[ctx.exp('%$type%','string')], {$: 'object', code: 'all', mark: '100' }]}
    ]
  }
})

jb.component('studio.select-profile', {
  type: 'control', 
  params: [
    { id: 'onSelect', type: 'action', dynamic: true }, 
    { id: 'type', as: 'string' }, 
    { id: 'path', as: 'string' }
  ], 
  impl :{$: 'group', 
    title: 'itemlist-with-find', 
    style :{$: 'layout.vertical', spacing: 3 }, 
    controls: [
      {$: 'itemlist-container.search', 
        title :{$: 'studio.prop-name', path: '%$path%' }, 
        searchIn :{$: 'itemlist-container.search-in-all-properties' }, 
        databind: '%$itemlistCntrData/search_pattern%', 
        style :{$: 'editable-text.mdl-input', width: '200' }, 
        features :{$: 'feature.onEsc', 
          action :{$: 'dialog.close-containing-popup', 
            id: 'studio-jb-editor-popup', 
            OK: false
          }
        }
      }, 
      {$: 'group', 
        title: 'categories and items', 
        style :{$: 'layout.horizontal', spacing: '33' }, 
        controls: [
          {$: 'itemlist', 
            title: 'items', 
            items :{
              $pipeline: [
                '%$Categories%', 
                {$: 'filter', 
                  filter :{$: 'or', 
                    items: [
                      {$: 'equals', 
                        item1: '%code%', 
                        item2: '%$SelectedCategory%'
                      }, 
                      {$: 'notEmpty', 
                        item: '%$itemlistCntrData/search_pattern%'
                      }
                    ]
                  }
                }, 
                '%pts%', 
                {$: 'itemlist-container.filter' }, 
                {$: 'unique', id: '%%', items: '%%' }
              ]
            }, 
            controls: [
              {$: 'label', 
                title :{$: 'highlight', 
                  base: '%%', 
                  highlight: '%$itemlistCntrData/search_pattern%'
                }, 
                style :{$: 'label.span', level: 'h3' }, 
                features: [
                  {$: 'css', css: '{ text-align: left; }' }, 
                  {$: 'css.padding', 
                    top: '0', 
                    left: '4', 
                    right: '4', 
                    bottom: '0'
                  }, 
                  {$: 'css.width', width: '250', minMax: 'min' }
                ]
              }
            ], 
            itemVariable: 'item', 
            features: [
              {$: 'css.height', height: '300', overflow: 'auto', minMax: '' }, 
              {$: 'itemlist.selection', 
                databind: '%$itemlistCntrData/selected%', 
                onSelection :{
                  $runActions: [
                    {
                      $if :{$: 'contains', 
                        text: ['control', 'style'], 
                        allText: '%$type%'
                      }, 
                      then :{
                        $call: 'onSelect', 
                        $vars: { selectionPreview: true }
                      }
                    }
                  ]
                }, 
                onDoubleClick :{
                  $runActions: [
                    {$: 'studio.clean-selection-preview' }, 
                    { $call: 'onSelect' }, 
                    {$: 'dialog.close-containing-popup' }
                  ]
                }, 
                autoSelectFirst: true
              }, 
              {$: 'itemlist.keyboard-selection', 
                onEnter :{
                  $runActions: [
                    {$: 'studio.clean-selection-preview' }, 
                    { $call: 'onSelect' }, 
                    {$: 'dialog.close-containing-popup' }
                  ]
                }
              }, 
              {$: 'watch-ref', ref: '%$SelectedCategory%' }, 
              {$: 'watch-ref', ref: '%$itemlistCntrData/search_pattern%' }, 
              {$: 'css.margin', top: '3', selector: '>li' }, 
              {$: 'css.width', width: '200' }
            ]
          }, 
          {$: 'picklist', 
            title: '', 
            databind: '%$SelectedCategory%', 
            options: '%$Categories%', 
            style :{$: 'style-by-control', 
              control :{$: 'group', 
                controls :{$: 'itemlist', 
                  items: '%$picklistModel/options/code%', 
                  controls :{$: 'label', 
                    title :{
                      $pipeline: [
                        '%$Categories%', 
                        {$: 'filter', filter: '%code% == %$item%' }, 
                        '%code% (%pts/length%)'
                      ]
                    }, 
                    style :{$: 'label.span' }, 
                    features: [
                      {$: 'css.width', width: '120' }, 
                      {$: 'css', css: '{text-align: left}' }, 
                      {$: 'css.padding', left: '10' }
                    ]
                  }, 
                  style :{$: 'itemlist.ul-li' }, 
                  watchItems: false, 
                  features: [
                    {$: 'itemlist.selection', 
                      cssForActive: 'background: white', 
                      databind: '%$SelectedCategory%', 
                      cssForSelected: 'box-shadow: 3px 0px 0 0 #304ffe inset; color: black !important; background: none !important; !important'
                    }
                  ]
                }, 
                features :{$: 'group.itemlist-container' }
              }, 
              modelVar: 'picklistModel'
            }, 
            features :{$: 'picklist.onChange', 
              action :{$: 'write-value', to: '%$itemlistCntrData/search_pattern%' }
            }
          }
        ]
      }, 
      {$: 'label', 
        title :{
          $pipeline: [
            '%$itemlistCntrData/selected%', 
            {$: 'studio.val', path: '%%' }, 
            '%description%'
          ]
        }, 
        style :{$: 'label.span' }
      }
    ], 
    features: [
      {$: 'css.margin', top: '10', left: '20' }, 
      {$: 'var', 
        name: 'unsortedCategories', 
        value :{$: 'studio.categories-of-type', type: '%$type%', path: '%$path%' }
      }, 
      {$: 'var', 
        name: 'Categories', 
        value :{$: 'picklist.sorted-options', 
          options: '%$unsortedCategories%', 
          marks :{$: 'studio.categories-marks', type: '%$type%', path: '%$path%' }
        }
      }, 
      {$: 'var', 
        name: 'SelectedCategory', 
        value :{
          $if :{$: 'studio.val', path: '%$path%' }, 
          then: 'all', 
          else: '%$Categories[0]/code%'
        }, 
        mutable: true
      }, 
      {$: 'var', name: 'SearchPattern', value: '', mutable: true }, 
      {$: 'group.itemlist-container', 
        initialSelection :{$: 'studio.comp-name', path: '%$path%' }
      }
    ]
  }
})

jb.component('studio.pick-profile', {
  description: 'picklist for picking a profile in a context',
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'button',
    title :{ $firstSucceeding: [{$: 'studio.comp-name', path: '%$path%' }, ''] },
    action :{$: 'open-dialog',
      style :{$: 'dialog.popup' },
      content :{$: 'studio.select-profile',
        onSelect :{$: 'studio.set-comp', path: '%$path%', comp: '%%' },
        type :{$: 'studio.param-type', path: '%$path%' },
        path: '%$path%'
      },
      features: [
        {$: 'dialog-feature.auto-focus-on-first-input' },
        {$: 'css.padding', right: '20' },
//				{$: 'var', name: 'initial-comps-index', value: {$: 'studio.comps-undo-index'}},
//	      {$: 'dialog-feature.onClose',
//	        action :{ $if: {$not:'%%'},	then: {$: 'studio.revert', toIndex: '%$initial-comps-index%' }}
//				},
      ]
    },
    style :{$: 'button.select-profile-style' },
    features :{$: 'studio.watch-path', path: '%$path%' }
  }
})

jb.component('studio.open-new-page', {
  type: 'action',
  impl :{$: 'open-dialog',
    style :{$: 'dialog.dialog-ok-cancel' },
		modal: true,
    features : [{$: 'var', name: 'name', mutable: true },
			{$: 'dialog-feature.auto-focus-on-first-input' }
		],
    content :{$: 'group',
      style :{$: 'group.div' },
      controls: [
        {$: 'editable-text',
          title: 'page name',
          databind: '%$name%',
          style :{$: 'editable-text.mdl-input' },
          features :{$: 'feature.onEnter',
            action :{$: 'dialog.close-containing-popup' }
          }
        }
      ],
      features :{$: 'css.padding', top: '14', left: '11' }
    },
    title: 'New Page',
    onOK: [
      {$: 'write-value',
        to :{$: 'studio.ref', path: '%$studio/project%.%$name%' },
        value :{$: 'json.parse',
          text: '{ "type": "control", "impl": {"$": "group", "title": "%$name%", "controls": []}}'
        }
      },
      //{$: 'studio.goto-path', path: '%$studio/project%.%$name%' },
      {$: 'write-value', to: '%$studio/profile_path%', value: '%$studio/project%.%$name%~impl' },
      {$: 'studio.open-control-tree'},
      {$: 'tree.regain-focus' },
      {$: 'on-next-timer',
        description: 'we need to wait for the itemlist to be updated with new page. However, the mutable name var is lost on next timer so we put it in context var as newName',
        $vars: { newName: '%$name%'},
        action: {$: 'write-value', to: '%$studio/page%', value: '%$newName%' },
      }
    ],
  }
})

jb.component('studio.insert-comp-option', {
  params: [
    { id: 'title', as: 'string' },
    { id: 'comp', as: 'string' },
  ],
  impl :{$: 'menu.action', title: '%$title%',
    action :{$: 'studio.insert-comp', comp: '%$comp%', type: 'control' },
  }
})

jb.component('studio.insert-control-menu', {
  impl :{$: 'menu.menu', title: 'Insert',
          options: [
          {$: 'menu.menu', title: 'Control', options: [
              {$: 'studio.insert-comp-option', title:'Label', comp: 'label'},
              {$: 'studio.insert-comp-option', title:'Button', comp: 'button'},
            ]
          },
          {$: 'menu.menu', title: 'Input', options: [
              {$: 'studio.insert-comp-option', title:'Editable Text', comp: 'editable-text'},
              {$: 'studio.insert-comp-option', title:'Editable Number', comp: 'editable-number'},
              {$: 'studio.insert-comp-option', title:'Editable Boolean', comp: 'editable-boolean'},
            ]
          },
          {$: 'menu.menu', title: 'Group', options: [
              {$: 'studio.insert-comp-option', title:'Group', comp: 'group'},
              {$: 'studio.insert-comp-option', title:'Itemlist', comp: 'itemlist'},
            ]
          },
          {$: 'menu.action',
              title: 'More...',
              action :{$: 'studio.open-new-profile-dialog', type: 'control', mode: 'insert-control' }
          }
          ]
        },
})

jb.studio.newControl = path =>
  new jb.jbCtx().run({$: 'studio.open-new-profile-dialog',
          path: path,
          type: 'control',
          mode: 'insert-control'
        });
;

jb.component('studio.preview-widget', {
  type: 'control',
  params: [
    { id: 'style', type: 'preview-style', dynamic: true, defaultValue :{$: 'studio.preview-widget-impl'}  },
    { id: 'width', as: 'number'},
    { id: 'height', as: 'number'},
  ],
  impl: ctx =>
    jb.ui.ctrl(ctx,{
      init: cmp => {
        cmp.state.project = ctx.exp('%$studio/project%');
        cmp.state.cacheKiller = 'cacheKiller='+(''+Math.random()).slice(10);
        document.title = cmp.state.project + ' with jBart';
      },
    })
})

jb.studio.initPreview = function(preview_window,allowedTypes) {
      var st = jb.studio;
      st.previewWindow = preview_window;
      st.previewjb = preview_window.jb;
      st.serverComps = st.previewjb.comps;
      st.compsRefHandler.allowedTypes = jb.studio.compsRefHandler.allowedTypes.concat(allowedTypes);

      st.previewjb.studio.studioWindow = window;
      st.previewjb.studio.previewjb = st.previewjb;
			st.previewjb.http_get_cache = {}

      st.initEventTracker();
      if (preview_window.location.href.match(/\/studio-helper/))
        st.previewjb.studio.initEventTracker();
      ['jb-component','jb-param'].forEach(comp=>st.previewjb.component(comp,jb.comps[comp]));

			fixInvalidUrl()

			function fixInvalidUrl() {
				var profile_path = location.href.split('/project/studio/').pop().split('/')[2] || '';
				if (!profile_path || jb.studio.valOfPath(profile_path,true) != null) return;
				while (profile_path && jb.studio.valOfPath(profile_path,true) == null)
					profile_path = jb.studio.parentPath(profile_path);
				window.open(location.href.split('/').slice(0,-1).concat([profile_path]).join('/'),'_self')
			}
}

jb.component('studio.preview-widget-impl', {
  type: 'preview-style',
  impl :{$: 'custom-style',
      template: (cmp,state,h) => h('iframe', {
          id:'jb-preview',
          sandbox: 'allow-same-origin allow-forms allow-scripts',
          frameborder: 0,
          class: 'preview-iframe',
          width: cmp.ctx.vars.$model.width,
          height: cmp.ctx.vars.$model.height,
          src: '/project/'+ state.project + '?' + state.cacheKiller
      }),
      css: `{box-shadow:  2px 2px 6px 1px gray; margin-left: 2px; margin-top: 2px;  }`
  }
})

jb.component('studio.refresh-preview', {
  type: 'action',
  impl: _ => {
    jb.ui.garbageCollectCtxDictionary(true);
    jb.studio.previewjb.ui.garbageCollectCtxDictionary(true);
    jb.studio.refreshPreviewWidget && jb.studio.refreshPreviewWidget()
  }
})

jb.component('studio.set-preview-size', {
  type: 'action',
  params: [
    { id: 'width', as: 'number'},
    { id: 'height', as: 'number'},
  ],
  impl: (ctx,width,height) => {
    if (width)
      document.querySelector('.preview-iframe').setAttribute('width',width);
    if (height)
      document.querySelector('.preview-iframe').setAttribute('height',height);
  }
})

jb.component('studio.wait-for-preview-iframe', {
  impl: _ =>
    jb.ui.waitFor(()=>
      jb.studio.previewWindow)
})

jb.studio.pageChange = jb.ui.resourceChange.filter(e=>e.path.join('/') == 'studio/page')
      .startWith(1)
      .map(e=>jb.resources.studio.project + '.' + jb.resources.studio.page);
;

(function() {
var st = jb.studio;

st.ControlTree = class {
	constructor(rootPath) {
		this.rootPath = rootPath;
		this.refHandler = st.compsRefHandler;
	}
	title(path,collapsed) {
		var val = st.valOfPath(path);
		if (path &&  (val == null || Array.isArray(val) && val.length == 0) && path.match(/~controls$/))
			return jb.ui.h('a',{style: {cursor: 'pointer', 'text-decoration': 'underline'}, onclick: e => st.newControl(path) },'add new');
		return this.fixTitles(st.shortTitle(path),path,collapsed)
	}
	// differnt from children() == 0, beacuse in the control tree you can drop into empty group
	isArray(path) {
		return this.children(path).length > 0;
	}
	children(path,nonRecursive) {
		return [].concat.apply([],st.controlParams(path).map(prop=>path + '~' + prop)
				.map(innerPath=> {
					var val = st.valOfPath(innerPath);
					if (Array.isArray(val) && val.length > 0)
					 return st.arrayChildren(innerPath,true);
					return [innerPath]
				}))
				.concat(nonRecursive ? [] : this.innerControlPaths(path));
	}
	move(from,to) {
		return st.moveFixDestination(from,to)
	}
	disabled(path) {
		return st.disabled(path)
	}
	icon(path) {
		return st.icon(path)
	}

	// private
	innerControlPaths(path) {
		// var nonControlChildren = [].concat.apply([],
		//  	st.nonControlChildren(path,true).map(innerPath=>Array.isArray(st.valOfPath(innerPath)) ? st.arrayChildren(innerPath,true) : [innerPath] ))
		// return [].concat.apply([],nonControlChildren.map(innerPath=>this.children(innerPath,true)))
		return ['action~content'] // add more inner paths here
			.map(x=>path+'~'+x)
			.filter(p=>
				st.paramTypeOfPath(p) == 'control');
	}
	fixTitles(title,path) {
		if (title == 'control-with-condition')
			return jb.ui.h('div',{},[this.title(path+'~control'),jb.ui.h('span',{class:'treenode-val'},'conditional') ]);
		return title;
	}
}

st.jbEditorTree = class {
	constructor(rootPath,includeCompHeader) {
		this.rootPath = rootPath;
		this.refHandler = st.compsRefHandler;
    this.includeCompHeader= includeCompHeader;
	}
	title(path, collapsed) {
		var val = st.valOfPath(path);
		var compName = st.compNameOfPath(path);
    if (path.indexOf('~') == -1)
      compName = 'jb-component';
    if (compName && compName.match(/case$/))
      compName = 'case';
		var prop = path.split('~').pop();
		if (!isNaN(Number(prop))) // array value - title as a[i]
			prop = path.split('~').slice(-2)
				.map(x=>x.replace(/\$pipeline/,''))
				.join('[') + ']';
		var summary = '';
		if (collapsed && typeof val == 'object')
			summary = ': ' + st.summary(path).substr(0,20);
    if (typeof val == 'function')
      val = val.toString();

		if (compName)
			return jb.ui.h('div',{},[prop + '= ',jb.ui.h('span',{class:'treenode-val', title: compName+summary},jb.ui.limitStringLength(compName+summary,50))]);
		else if (['string','boolean','number'].indexOf(typeof val) != -1)
			return jb.ui.h('div',{},[prop + (collapsed ? ': ': ''),jb.ui.h('span',{class:'treenode-val', title: ''+val},jb.ui.limitStringLength(''+val,50))]);

		return prop + (Array.isArray(val) ? ` (${val.length})` : '');
	}
	isArray(path) {
		return this.children(path).length > 0;
	}
	children(path) {
		var val = st.valOfPath(path);
		if (!val) return [];
		return (st.arrayChildren(path) || [])
//        .concat((this.includeCompHeader && this.compHeader(path,val)) || [])
				.concat(this.vars(path,val) || [])
				.concat(this.sugarChildren(path,val) || [])
				.concat(this.specialCases(path,val) || [])
				.concat(this.innerProfiles(path,val) || [])
	}
	move(from,to) {
		return jb.move(st.refOfPath(from),st.refOfPath(to))
	}
	disabled(path) {
		return st.disabled(path)
	}
	icon(path) {
		return st.icon(path)
	}

	// private
	sugarChildren(path,val) {
		var compName = jb.compName(val);
		var sugarPath = path + '~$' +compName;
		var sugarVal = st.valOfPath(sugarPath);
		if (Array.isArray(sugarVal)) // sugar array. e.g. $pipeline: [ .. ]
			return st.arrayChildren(sugarPath);
		else if (sugarVal)
			return [sugarPath];
	}
	innerProfiles(path,val) {
		if (this.sugarChildren(path,val)) return [];
    if (!this.includeCompHeader && path.indexOf('~') == -1)
      path = path + '~impl';
		return st.paramsOfPath(path).map(p=> ({ path: path + '~' + p.id, param: p}))
			.filter(e=>st.valOfPath(e.path) != null || e.param.essential)
			.map(e=>e.path)
	}
	vars(path,val) {
		return val && typeof val == 'object' && typeof val.$vars == 'object' && [path+'~$vars']
	}

	specialCases(path,val) {
		if (jb.compName(val) == 'object' || path.match(/~\$vars$/))
			return Object.getOwnPropertyNames(val)
				.filter(p=>p!='$')
				.filter(p=>p.indexOf('$jb_') != 0)
				.map(p=>path+'~'+p);
		if (jb.compName(val) == 'if')
			return ['then','else']
		return []
	}
  // compHeader(path,val) {
	// 	if (path.indexOf('~impl') == -1 && !st.isPrimitiveValue(val) && !Array.isArray(val))
  //     return Object.getOwnPropertyNames(val)
  //       .filter(p=>p!='$' && p.indexOf('$jb_') != 0)
  //       .map(p=>path+'~'+p);
	// }

}


Object.assign(st,{
	jbEditorMoreParams: path =>
		st.paramsOfPath(path)
			.filter(p=>st.valOfPath(path+'~'+p.id) == null && !p.essential)
			.map(p=> path + '~' + p.id),

  // compHeaderParams: path => {
  //   if (path.indexOf('~') == -1)
  //     return [
  //   if (path.indexOf('~impl~') == -1 && path.match(/~params~[0-9]*$/))
  //     return ['id','type','as','essential']
  // }
	nonControlChildren: (path,includeFeatures) =>
		st.paramsOfPath(path).filter(p=>!st.isControlType(p.type))
			.filter(p=>includeFeatures || p.id != 'features')
			.map(p=>path + '~' + p.id),

	arrayChildren: (path,noExtraElem) => {
		var val = st.valOfPath(path);
		if (Array.isArray(val))
			return Object.getOwnPropertyNames(val)
				.filter(x=> x.indexOf('$jb_') != 0)
				.filter(x=> !(noExtraElem && x =='length'))
				.map(x=>x=='length'? val.length : x) // extra elem
				.map(k=> path +'~'+k);
		return [];
	},
	asArrayChildren: path => { // support the case of single element - used by properties features
		var val = st.valOfPath(path);
		if (Array.isArray(val))
			return st.arrayChildren(path,true)
		else if (val)
			return [path]
	},
	isControlType: type =>
		(type||'').match(/^(control|options|menu|table-field)/),
	controlParams: path =>
		st.paramsOfPath(path).filter(p=>st.isControlType(p.type)).map(p=>p.id),

	summary: path => {
		var val = st.valOfPath(path);
    if (path.match(/~cases~[0-9]*$/))
      return st.summary(path+'~condition');
		if (val == null || typeof val != 'object') return '';
		return Object.getOwnPropertyNames(val)
			.filter(p=> p != '$')
			.filter(p=> p.indexOf('$jb_') != 0)
			.map(p=>val[p])
			.filter(v=>typeof v != 'object')
			.join(', ');
	},

	shortTitle: path => {
		if (path == '') return '';
		if (path.indexOf('~') == -1)
			return path;
		if (path.match(/~impl$/))
			return path.split('~')[0];

		var val = st.valOfPath(path);
		return (val && typeof val.title == 'string' && val.title) || (val && val.Name) || (val && val.remark) || (val && st.compNameOfPath(path)) || path.split('~').pop();
	},
	icon: path => {
		if (st.parentPath(path)) {
			var parentVal = st.valOfPath(st.parentPath(path));
			if (Array.isArray(parentVal) && path.split('~').pop() == parentVal.length)
				return 'add';
		}
		if (st.paramTypeOfPath(path) == 'control') {
			if (st.valOfPath(path+'~style',true) && st.compNameOfPath(path+'~style') == 'layout.horizontal')
				return 'view_column'
			return 'folder_open'; //'view_headline' , 'folder_open'
		}
		var comp2icon = {
			label: 'font_download',
			button: 'crop_landscape',
			tab: 'tab',
			image: 'insert_photo',
			'custom-control': 'build',
			'editable-text': 'data_usage',
			'editable-boolean': 'radio_button',
			'editable-number': 'donut_large',
		}
		var compName = st.compNameOfPath(path);
		if (comp2icon[compName])
			return comp2icon[compName];

		if (st.isOfType(path,'action'))
			return 'play_arrow'

		return 'radio_button_unchecked';
	},

	// queries
	isCompNameOfType: (name,type) => {
		var _jb = st.previewjb;
		var comp = name && _jb.comps[name];
		if (comp) {
			while (_jb.comps[name] && !_jb.comps[name].type && _jb.compName(_jb.comps[name].impl))
				name = _jb.compName(_jb.comps[name].impl);
			return (_jb.comps[name] && _jb.comps[name].type || '').indexOf(type) == 0;
		}
	},
	paramDef: path => {
		if (!st.parentPath(path)) // no param def for root
			return;
		if (!isNaN(Number(path.split('~').pop()))) // array elements
			path = st.parentPath(path);
		// var parent_prof = st.valOfPath(st.parentPath(path),true);
		// var comp = parent_prof && st.getComp(jb.compName(parent_prof));
		var comp = st.compOfPath(st.parentPath(path),true);
		var params = jb.compParams(comp);
		var paramName = path.split('~').pop();
		if (paramName.indexOf('$') == 0) // sugar
			return params[0];
		return params.filter(p=>p.id==paramName)[0] || {};
	},

	isOfType: (path,type) => {
    if (path.indexOf('~') == -1)
		  return st.isCompNameOfType(path,type);
		var paramDef = st.paramDef(path);
		if (paramDef)
			return (paramDef.type || 'data').split(',')
				.map(x=>x.split('[')[0]).filter(_t=>type.split(',').indexOf(_t) != -1).length;
	},
	// single first param type
	paramTypeOfPath: path => {
		var res = ((st.paramDef(path) || {}).type || 'data').split(',')[0].split('[')[0];
		if (res == '*')
			return st.paramTypeOfPath(st.parentPath(path));
		return res;
	},
	PTsOfPath: path =>
		st.PTsOfType(st.paramTypeOfPath(path)),

	PTsOfType: type => {
		var single = /([^\[]*)([])?/;
		var types = [].concat.apply([],(type||'').split(',')
			.map(x=>
				x.match(single)[1])
			.map(x=>
				x=='data' ? ['data','aggregator','boolean'] : [x]));
		var comp_arr = types.map(t=>
			jb.entries(st.previewjb.comps)
				.filter(c=>
					(c[1].type||'data').split(',').indexOf(t) != -1
					|| (c[1].typePattern && t.match(c[1].typePattern))
				)
				.map(c=>c[0]));
		return comp_arr.reduce((all,ar)=>all.concat(ar),[]);
	},

	propName: path =>{
		if (!isNaN(Number(path.split('~').pop()))) // array elements
			return st.parentPath(path).split('~').pop().replace(/s$/,'');

		var paramDef = st.paramDef(path);
		if (!paramDef) return '';
		var val = st.valOfPath(path);
		if ((paramDef.type ||'').indexOf('[]') != -1) {
			var length = st.arrayChildren(path).length;
			if (length)
				return path.split('~').pop() + ' (' + length + ')';
		}

		return path.split('~').pop();
	}

})

})()
;


jb.component('studio.data-resources', {
  type: 'control', 
  impl :{$: 'group', 
    controls: [
      {$: 'itemlist', 
        items: '%$samples%', 
        controls: [
          {$: 'button', 
            title: '%%', 
            style :{$: 'button.mdl-flat-ripple' }
          }
        ], 
        style :{$: 'itemlist.ul-li' }, 
        watchItems: true, 
        itemVariable: 'item'
      }, 
      {$: 'button', 
        title: 'add resource', 
        style :{$: 'button.mdl-icon', icon: 'add', size: 20 }
      }, 
      {$: 'group', 
        style :{$: 'group.section' }, 
        controls: [
          {$: 'itemlist', 
            items :{$: 'list', items: ['1', '2', '3'] }, 
            style :{$: 'itemlist.ul-li' }, 
            watchItems: true, 
            itemVariable: 'item'
          }
        ], 
        features :{$: 'var', name: 'selected_in_itemlist', mutable: true }
      }
    ], 
    features :{$: 'group.wait', 
      for :{$: 'level-up.entries', 
        db :{$: 'level-up.file-db', rootDirectory: '/projects/data-tests/samples' }
      }, 
      resource: 'samples', 
      mapToResource: '%%'
    }
  }
})

jb.component('studio.open-resource', {
	type: 'action',
	params: [
	    { id: 'resource', type: 'data' },
	    { id: 'id', as: 'string' }
	], 
	impl :{$: 'open-dialog',
		title: '%$id%',
		style :{$: 'dialog.studio-floating', id: 'resource %$id%', width: 500 },
		content :{$: 'tree',
		    nodeModel :{$: 'tree.json-read-only', 
		      object: '%$resource%', rootPath: '%$id%' 
		    },
		    features: [
	   	        { $: 'css.class', class: 'jb-control-tree'},
		        { $: 'tree.selection' },
		        { $: 'tree.keyboard-selection'} 
		    ] 
		 },
	}
})

jb.component('studio.data-resource-menu', {
  type: 'menu.option', 
  impl :{$: 'menu.menu', 
    title: 'Data', 
    options: [
      {$: 'dynamic-controls', 
        controlItems :{
          $pipeline: [
            ctx => jb.studio.previewjb.resources, 
            {$: 'property-names', obj: '%%' }, 
            {$: 'filter', 
              filter :{$: 'not-contains', inOrder: true, text: ':', allText: '%%' }
            }
          ]
        }, 
        genericControl :{$: 'menu.action', 
          title: '%$controlItem%', 
          action :{$: 'studio.open-resource', 
            resource: function (ctx) {
                     return jb.path(jb, ['previewWindow', 'jbart_widgets', ctx.exp('%$studio/project%'), 'resources', ctx.exp('%$controlItem%')]);
                }, 
            id: '%$controlItem%'
          }
        }
      }
    ]
  }
})

;

(function() {
var st = jb.studio;

jb.component('studio.val', {
	params: [ {id: 'path', as: 'string', essential: true } ],
	impl: (ctx,path) =>
		st.valOfPath(path)
})

jb.component('studio.is-primitive-value', {
  params: [ {id: 'path', as: 'string', essential: true } ],
  impl: (ctx,path) =>
      st.isPrimitiveValue(st.valOfPath(path))
})

jb.component('studio.is-of-type', {
  params: [
  	{ id: 'path', as: 'string', essential: true },
  	{ id: 'type', as: 'string', essential: true },
  ],
  impl: (ctx,path,_type) =>
      st.isOfType(path,_type)
})

jb.component('studio.param-type', {
  params: [
  	{ id: 'path', as: 'string', essential: true },
  ],
  impl: (ctx,path) =>
      st.paramTypeOfPath(path)
})

jb.component('studio.PTs-of-type', {
  params: [
  	{ id: 'type', as: 'string', essential: true },
  ],
  impl: (ctx,_type) =>
      st.PTsOfType(_type)
})

jb.component('studio.categories-of-type', {
  params: [
  	{ id: 'type', as: 'string', essential: true },
		{ id: 'path', as: 'string' },
  ],
  impl: (ctx,_type,path) => {
		var val = st.valOfPath(path);
  	var comps = st.previewjb.comps;
  	var pts = st.PTsOfType(_type);
  	var categories = jb.unique([].concat.apply([],pts.map(pt=>
  		(comps[pt].category||'').split(',').map(c=>c.split(':')[0])
  			.concat(pt.indexOf('.') != -1 ? pt.split('.')[0] : [])
  			.filter(x=>x).filter(c=>c!='all')
			))).map(c=>({
  				code: c,
  				pts: ptsOfCategory(c)
  			}));
  	var res = categories.concat({code: 'all', pts: ptsOfCategory('all') });
		return res;

  	function ptsOfCategory(category) {
      var pts_with_marks = pts.filter(pt=>
      		category == 'all' || pt.split('.')[0] == category ||
      		(comps[pt].category||'').split(',').map(x=>x.split(':')[0]).indexOf(category) != -1)
      	.map(pt=>({
	      	pt: pt,
	      	mark: (comps[pt].category||'').split(',')
	      		.filter(c=>c.indexOf(category) == 0)
	      		.map(c=>Number(c.split(':')[1] || 50))[0]
	      }))
      	.map(x=> {
      		if (x.mark == null)
      			x.mark = 50;
      		return x;
      	})
      	.filter(x=>x.mark != 0);
	  	pts_with_marks.sort((c1,c2)=>c2.mark-c1.mark);
	  	var out = pts_with_marks.map(pt=>pt.pt);
			return out;
  	}
  }
})

jb.component('studio.short-title', {
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		st.shortTitle(path)
})

jb.component('studio.summary', {
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		st.summary(path)
})

jb.component('studio.has-param', {
	params: [
		{ id: 'path', as: 'string' },
		{ id: 'param', as: 'string' },
	],
	impl: (ctx,path,param) =>
		st.paramDef(path+'~'+param)
})

jb.component('studio.non-control-children', {
	params: [
		{id: 'path', as: 'string' },
		{id: 'includeFeatures', as: 'boolean' },
	],
	impl: (ctx,path,includeFeatures) =>
		st.nonControlChildren(path,includeFeatures)
})

jb.component('studio.as-array-children', {
	params: [
		{id: 'path', as: 'string' },
	],
	impl: (ctx,path) =>
		st.asArrayChildren(path)
})

jb.component('studio.comp-name',{
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) => st.compNameOfPath(path) || ''
})

jb.component('studio.param-def',{
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) => st.paramDef(path)
})

jb.component('studio.enum-options',{
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		((st.paramDef(path) || {}).options ||'').split(',').map(x=>({code:x,text:x}))
})

jb.component('studio.prop-name',{
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		st.propName(path)
})

jb.component('studio.more-params',{
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
        st.jbEditorMoreParams(path)
})


jb.component('studio.comp-name-ref', {
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) => ({
			$jb_val: function(value) {
				if (typeof value == 'undefined')
					return st.compNameOfPath(path);
				else
					st.setComp(path,value,ctx)
			},
			$jb_observable: cmp =>
				st.refObservable(st.refOfPath(path),cmp,{includeChildren: true})
	})
})

jb.component('studio.profile-as-text', {
	type: 'data',
	params: [{ id: 'path', as: 'string', dynamic: true } ],
	impl: ctx => ({
		$jb_val: function(value) {
			var path = ctx.params.path();
			if (!path) return '';
			if (typeof value == 'undefined') {
      	var val = st.valOfPath(path);
      	if (typeof val == 'function')
            return val.toString();

      	if (st.isPrimitiveValue(val))
      		return ''+val;
      	return jb.prettyPrint(val || '');
      } else {
      	var notPrimitive = value.match(/^\s*(\(|{|\[)/) || value.match(/^\s*ctx\s*=>/) || value.match(/^function/);
      	var newVal = notPrimitive ? st.evalProfile(value) : value;
      	if (newVal != null)
      		st.writeValueOfPath(path, newVal,ctx);
      }
		},
		$jb_observable: cmp =>
			st.refObservable(st.refOfPath(ctx.params.path()),cmp,{includeChildren: true})
	})
})

jb.component('studio.profile-as-string-byref', {
	type: 'data',
	params: [{ id: 'path', as: 'string', dynamic: true } ],
	impl: ctx => ({
		$jb_val: function(value) {
			var path = ctx.params.path();
			if (!path) return '';
			if (typeof value == 'undefined') {
				return st.valOfPath(path) || '';
			} else {
				st.writeValueOfPath(path, value,ctx);
			}
		},
		$jb_observable: cmp =>
			st.refObservable(st.refOfPath(ctx.params.path()),cmp)
	})
})

jb.component('studio.profile-value-as-text', {
  type: 'data',
  params: [ { id: 'path', as: 'string' } ],
  impl: (ctx,path) => ({
      $jb_val: function(value) {
        if (typeof value == 'undefined') {
          var val = st.valOfPath(path);
          if (val == null)
            return '';
          if (st.isPrimitiveValue(val))
            return ''+val;
          if (st.compNameOfPath(path))
            return '=' + st.compNameOfPath(path);
        }
        else if (value.indexOf('=') != 0)
          st.writeValueOfPath(path, value,ctx);
      }
    })
})

jb.component('studio.insert-control',{
	type: 'action',
	params: [
		{ id: 'path', as: 'string', defaultValue :{$: 'studio.currentProfilePath' }  },
		{ id: 'comp', as: 'string' },
	],
	impl: (ctx,path,comp,type) =>
		st.insertControl(path, comp,ctx)
})

jb.component('studio.wrap', {
	type: 'action',
	params: [
		{ id: 'path', as: 'string' },
		{ id: 'comp', as: 'string' }
	],
	impl: (ctx,path,comp) =>
		st.wrap(path,comp,ctx)
})

jb.component('studio.wrap-with-group', {
	type: 'action',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		st.wrapWithGroup(path,ctx)
})

jb.component('studio.add-property', {
	type: 'action',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		st.addProperty(path,ctx)
})

jb.component('studio.duplicate-control',{
	type: 'action',
	params: [ { id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		st.duplicateControl(path,ctx)
})

jb.component('studio.duplicate-array-item',{
	type: 'action',
	params: [ { id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		st.duplicateArrayItem(path,ctx)
})

// jb.component('studio.move-in-array',{
// 	type: 'action',
// 	params: [
// 		{ id: 'path', as: 'string' },
// 		{ id: 'moveUp', type: 'boolean', as: 'boolean'}
// 	],
// 	impl: (ctx,path,moveUp) =>
// 		st.moveInArray(path,moveUp)
// })

jb.component('studio.new-array-item', {
	type: 'action',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		st.addArrayItem(path,ctx)
})

jb.component('studio.add-array-item',{
	type: 'action',
	params: [
		{id: 'path', as: 'string' },
		{id: 'toAdd', as: 'single' }
	],
	impl: (ctx,path,toAdd) =>
		st.addArrayItem(path, toAdd,ctx)
})

jb.component('studio.wrap-with-array',{
	type: 'action',
	params: [
		{id: 'path', as: 'string' },
	],
	impl: (ctx,path,toAdd) =>
		st.wrapWithArray(path,ctx)
})

jb.component('studio.can-wrap-with-array', {
  type: 'boolean',
  params: [ {id: 'path', as: 'string' } ],
  impl: (ctx,path) =>
      st.paramDef(path) && (st.paramDef(path).type || '').indexOf('[') != -1 && !Array.isArray(st.valOfPath(path))
})

jb.component('studio.is-array-item', {
  type: 'boolean',
  params: [ {id: 'path', as: 'string' } ],
  impl: (ctx,path) =>
      Array.isArray(st.valOfPath(st.parentPath(path)))
})


jb.component('studio.set-comp',{
	type: 'action',
	params: [
		{id: 'path', as: 'string' },
		{id: 'comp', as: 'single' }
	],
	impl: (ctx,path,comp) =>
		st.setComp(path, comp,ctx)
})

jb.component('studio.delete',{
	type: 'action',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) => st._delete(path,ctx)
})

jb.component('studio.disabled',{
	type: 'boolean',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) => st.disabled(path,ctx)
})

jb.component('studio.toggle-disabled',{
	type: 'action',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) => st.toggleDisabled(path,ctx)
})

jb.component('studio.make-local',{
	type: 'action',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) => st.makeLocal(path,ctx)
})

jb.component('studio.jb-editor.nodes', {
	type: 'tree.nodeModel',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		  new st.jbEditorTree(path,true)
})

jb.component('studio.icon-of-type', {
	type: 'data',
	params: [ {id: 'type', as: 'string' } ],
	impl: (ctx,type) => {
		if (type.match(/.style$/))
			type = 'style';
		return ({
			action: 'play_arrow',
			data: 'data_usage',
			aggregator: 'data_usage',
			control: 'airplay',
			style: 'format_paint',
			feature: 'brush'
		}[type] || 'extension')
	}

})

jb.component('studio.is-disabled', {
	type: 'boolean',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		  st.disabled(path)
})

jb.component('studio.disabled-support', {
  params: [
    { id: 'path', as: 'string', essential: true },
  ],
  type: 'feature',
  impl: {$: 'conditional-class', cssClass: 'jb-disabled', condition: {$: 'studio.is-disabled', path: '%$path%'} }
})


})();
;

jb.component('studio.open-control-tree', {
  type: 'action',
  impl :{$: 'open-dialog',
    style :{$: 'dialog.studio-floating', id: 'studio-outline', width: '350' },
    content :{$: 'studio.control-tree' },
    menu :{$: 'button',
      title: ' ',
      action :{$: 'studio.open-tree-menu', path: '%$studio/profile_path%' },
      style :{$: 'button.mdl-icon', icon: 'menu' },
      features :{$: 'css', css: '{ background: none }' }
    },
    title: 'Outline'
  }
})

jb.component('studio.open-tree-menu', {
  type: 'action',
  params: [
    { id: 'path', as: 'string' }
  ],
  impl :{$: 'menu.open-context-menu', menu :{$: 'studio.tree-menu', path: '%$path%'} }
})

jb.component('studio.tree-menu', {
  type: 'menu.option',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'menu.menu',
    options: [
      {$: 'menu.action',
        title: 'Insert',
        action :{$: 'studio.open-new-profile-dialog',
          type: 'control',
          mode: 'insert-control'
        }
      },
      {$: 'menu.action',
        title: 'Wrap with group',
        action: [
          {$: 'studio.wrap-with-group', path: '%$path%' },
          {$: 'on-next-timer',
            action: [
              {$: 'write-value',
                to: '%$studio/profile_path%',
                value: '%$path%~controls~0'
              },
              {$: 'tree.regain-focus' }
            ]
          }
        ]
      },
      {$: 'menu.action',
        title: 'Duplicate',
        action :{$: 'studio.duplicate-control', path: '%$path%' },
        shortcut: 'Ctrl+D',
      },
      {$: 'menu.separator' },
      {$: 'menu.action',
        title: 'inteliscript editor',
        action :{$: 'studio.open-jb-editor', path: '%$path%' }
      },
      {$: 'menu.action',
        title: 'context viewer',
        action :{$: 'studio.open-context-viewer', path: '%$path%' }
      },
      {$: 'menu.action',
        title: 'javascript editor',
        action :{$: 'studio.edit-source', path: '%$path%' },
        icon: 'code',
        shortcut: 'Ctrl+J',
      },
      {$: 'menu.action',
        $vars: {
          compName :{$: 'studio.comp-name', path: '%$path%' }
        },
        title: 'Goto %$compName%',
        action :{$: 'studio.goto-path', path: '%$compName%' },
        showCondition: '%$compName%'
      },
      {$: 'studio.goto-editor-options', path: '%$path%' },
      {$: 'menu.separator' },
      {$: 'menu.end-with-separator',
        options :{$: 'studio.goto-references-options',
          path: '%$path%',
          action: [
            {$: 'write-value', to: '%$studio/profile_path%', value: '%%' },
            {$: 'studio.open-control-tree', selection: '%$path%' }
          ]
        }
      },
      {$: 'menu.action',
        title: 'Delete',
        action :{$: 'studio.delete', path: '%$path%' },
        icon: 'delete',
        shortcut: 'Delete'
      },
      {$: 'menu.action',
        title: {$if: {$: 'studio.disabled', path: '%$path%'} , then: 'Enable', else: 'Disable' },
        icon: 'do_not_disturb',
        shortcut: 'Ctrl+X',
        action: {$: 'studio.toggle-disabled', path: '%$path%' }
      },
      {$: 'menu.action',
        title: 'Copy',
        action :{$: 'studio.copy', path: '%$path%' },
        icon: 'copy',
        shortcut: 'Ctrl+C'
      },
      {$: 'menu.action',
        title: 'Paste',
        action :{$: 'studio.paste', path: '%$path%' },
        icon: 'paste',
        shortcut: 'Ctrl+V'
      },
      {$: 'menu.action',
        title: 'Undo',
        action :{$: 'studio.undo' },
        icon: 'undo',
        shortcut: 'Ctrl+Z'
      },
      {$: 'menu.action',
        title: 'Redo',
        action :{$: 'studio.redo' },
        icon: 'redo',
        shortcut: 'Ctrl+Y'
      }
    ]
  }
})

jb.component('studio.control-tree', {
  type: 'control',
  impl :{$: 'group',
    controls: [
      {$: 'tree',
        nodeModel :{$: 'studio.control-tree.nodes' },
        features: [
          {$: 'css.class', class: 'jb-control-tree' },
          {$: 'tree.selection',
            databind: '%$studio/profile_path%',
            onSelection: [
              {$: 'studio.open-properties' },
              {$: 'studio.highlight-in-preview',
                path :{$: 'studio.currentProfilePath' }
              }
            ],
            autoSelectFirst: true,
          },
          {$: 'tree.keyboard-selection',
            onEnter :{$: 'studio.open-properties', focus: true },
            onRightClickOfExpanded :{$: 'studio.open-tree-menu', path: '%%' },
            applyMenuShortcuts :{$: 'studio.tree-menu', path: '%%' },
//            autoFocus: true,
          },
          {$: 'tree.drag-and-drop' },
//          {$: 'studio.control-tree.refresh-path-changes' },
          {$: 'studio.watch-script-changes' }
          // {$: 'tree.onMouseRight',
          //   action :{$: 'studio.open-tree-menu', path: '%%' }
          // }
        ]
      }
    ],
    features :[
        {$: 'css.padding', top: '10' },
        //{$: 'studio.watch-path', path :{$: 'studio.currentProfilePath' } },
    ]
  }
})

jb.component('studio.control-tree.nodes', {
	type: 'tree.nodeModel',
	impl: function(context) {
		var currentPath = context.run({ $: 'studio.currentProfilePath' });
		var compPath = currentPath.split('~')[0] || '';
		return new jb.studio.ControlTree(compPath + '~impl');
	}
})

// after model modifications the paths of the selected and expanded nodes may change and the tree should fix it.
// jb.component('studio.control-tree.refresh-path-changes', {
//   type: 'feature',
//   impl: ctx => ({
//     init : cmp => {
//       var tree = cmp.ctx.vars.$tree;
//       if (!tree) return;
//       jb.studio.compsRefHandler.resourceChange.takeUntil( cmp.destroyed )
//         .subscribe(opEvent => {
//           var new_expanded = {};
//           jb.entries(tree.expanded)
//             .filter(e=>e[1]).map(e=>e[0])
//             .map(path=> fixPath(path,opEvent))
//             .filter(x=>x)
//             .forEach(path => new_expanded[path] = true)
//           tree.expanded = new_expanded;
//           tree.selectionEmitter.next(fixPath(tree.selected,opEvent));
//         })
//
//         function fixPath(path,opEvent) {
//           var oldPath = opEvent.oldRef.$jb_path.join('~');
//           if (path.indexOf(oldPath) == 0)
//             return opEvent.ref.$jb_invalid ? null : path.replace(oldPath,opEvent.ref.$jb_path.join('~'));
//           return path;
//         }
//     }
//   })
// })
;

jb.component('studio.open-multiline-edit', {
	type: 'action',
	params: [
	    { id: 'path', as: 'string' }
	],
	impl: {
		$: 'open-dialog',
		style :{$: 'dialog.studio-multiline-edit' },
		content :{$: 'editable-text',
			databind :{$: 'studio.ref', path: '%$path%' },
			style :{$: 'editable-text.codemirror',
				mode :{$: 'studio.code-mirror-mode', path: '%$path%'}
			},
//			features: {$: 'studio.undo-support', path: '%$path%' },
		}
	}
})

jb.component('dialog.studio-floating', {
	type: 'dialog.style',
	params: [
		{ id: 'id', as: 'string' },
		{ id: 'width', as: 'number', defaultValue: 300},
		{ id: 'height', as: 'number', defaultValue: 100},
	],
	impl :{$: 'custom-style',
			template: (cmp,state,h) => h('div',{ class: 'jb-dialog jb-default-dialog', dialogId: cmp.id},[
				h('div',{class: 'dialog-title noselect'},state.title),
				cmp.hasMenu ? h('div',{class: 'dialog-menu'},h(cmp.menuComp)): '',
				h('button',{class: 'dialog-close', onclick:
					_=> cmp.dialogClose() },'×'),
				h('div',{class: 'jb-dialog-content-parent'},h(state.contentComp)),
			]),
			features: [
					{$: 'dialog-feature.drag-title', id: '%$id%'},
					{$: 'dialog-feature.unique-dialog', id: '%$id%', remeberLastLocation: true },
					{$: 'dialog-feature.max-zIndex-on-click', minZIndex: 5000 },
					{$: 'studio-dialog-feature.refresh-title' },
					{$: 'studio-dialog-feature.studio-popup-location' },
			],
			css: `{ position: fixed;
						background: #F9F9F9;
						width: %$width%px;
						max-width: 1200px;
						min-height: %$height%px;
						overflow: auto;
						border-radius: 4px;
						padding: 0 12px 12px 12px;
						box-shadow: 0px 7px 8px -4px rgba(0, 0, 0, 0.2), 0px 13px 19px 2px rgba(0, 0, 0, 0.14), 0px 5px 24px 4px rgba(0, 0, 0, 0.12)
				}
				>.dialog-title { background: none; padding: 10px 5px; }
				>.jb-dialog-content-parent { padding: 0; overflow-y: auto; overflow-x: hidden; }
				>.dialog-close {
						position: absolute;
						cursor: pointer;
						right: 4px; top: 4px;
						font: 21px sans-serif;
						border: none;
						background: transparent;
						color: #000;
						text-shadow: 0 1px 0 #fff;
						font-weight: 700;
						opacity: .2;
				}
				>.dialog-menu {
						position: absolute;
						cursor: pointer;
						right: 24px; top: 0;
						font: 21px sans-serif;
						border: none;
						background: transparent;
						color: #000;
						text-shadow: 0 1px 0 #fff;
						font-weight: 700;
						opacity: .2;
				}
				>.dialog-close:hover { opacity: .5 }`
	}
})

jb.component('studio-dialog-feature.studio-popup-location',{
	type: 'dialog-feature',
	impl: ctx => ({
		afterViewInit: cmp => {
			var dialog = cmp.dialog;
			var id = (dialog.id||'').replace(/\s/g,'_');
			if (id && !sessionStorage[id]) {
				dialog.el.classList.add(id);
				dialog.el.classList.add('default-location')
			}
		}
	})
})

jb.component('studio-dialog-feature.refresh-title', {
	type: 'dialog-feature',
	impl: ctx => ({
		afterViewInit: cmp =>
			jb.studio.scriptChange.subscribe(e=>
				cmp.recalcTitle && cmp.recalcTitle(e,ctx))
	})
})

jb.component('studio.code-mirror-mode',{
	params: [ {id: 'path', as: 'string' } ],
	impl: function(ctx,path) {
		if (path.match(/css/))
			return 'css';
		if (path.match(/template/) || path.match(/html/))
			return 'htmlmixed';
		return 'javascript'
	}
})

jb.component('studio.open-responsive-phone-popup', {
  type: 'action',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'open-dialog',
    style :{$: 'dialog.studio-floating', id: 'responsive' },
    content :{$: 'tabs',
      tabs :{$: 'dynamic-controls',
        controlItems :{
          $asIs: [
            {
              width: { min: 320, max: 479, default: 400 },
              height: { min: 300, max: 700, default: 600 },
              id: 'phone'
            },
            {
              width: { min: 480, max: 1024, default: 600 },
              height: { min: 300, max: 1440, default: 850 },
              id: 'tablet'
            },
            {
              width: { min: 1024, max: 2048, default: 1280 },
              height: { min: 300, max: 1440, default: 520 },
              id: 'desktop'
            }
          ]
        },
        genericControl :{$: 'group',
          title: '%$controlItem/id%',
          style :{$: 'property-sheet.titles-left',
            vSpacing: 20,
            hSpacing: 20,
            titleWidth: 100
          },
          controls: [
            {$: 'editable-number',
              databind: '%$studio/responsive/{%$controlItem/id%}/width%',
              title: 'width',
              style :{$: 'editable-number.slider' },
              min: '%$controlItem/width/min%',
              max: '%$controlItem/width/max%',
              features: [
                {$: 'field.default', value: '%$controlItem/width/default%' },
                {$: 'field.subscribe',
                  action :{$: 'studio.set-preview-size', width: '%%' },
                  includeFirst: true
                }
              ]
            },
            {$: 'editable-number',
              databind: '%$studio/responsive/{%$controlItem/id%}/height%',
              title: 'height',
              style :{$: 'editable-number.slider' },
              min: '%$controlItem/height/min%',
              max: '%$controlItem/height/max%',
              features: [
                {$: 'field.default', value: '%$controlItem/height/default%' },
                {$: 'field.subscribe',
                  action :{$: 'studio.set-preview-size', height: '%%' },
                  includeFirst: true
                }
              ]
            }
          ],
          features: [{$: 'css', css: '{ padding-left: 12px; padding-top: 7px }' }]
        }
      },
      style :{$: 'tabs.simple' }
    },
    title: 'responsive'
  }
})
;


jb.component('studio.open-properties', {
  type: 'action',
  params: [{ id: 'focus', type: 'boolean', as: 'boolean' }],
  impl :{$: 'open-dialog',
    style :{$: 'dialog.studio-floating', id: 'studio-properties', width: '500' },
    content :{$: 'studio.properties',
      path :{$: 'studio.currentProfilePath' }
    },
    title :{
      $pipeline: [
        {$: 'object',
          title :{$: 'studio.short-title',
            path :{$: 'studio.currentProfilePath' }
          },
          comp :{$: 'studio.comp-name',
            path :{$: 'studio.currentProfilePath' }
          }
        },
        'Properties of %comp% %title%'
      ]
    },
    features: [
      {
        $if: '%$focus%',
        then :{$: 'dialog-feature.auto-focus-on-first-input' }
      },
      {$: 'dialog-feature.keyboard-shortcut',
        shortcut: 'Ctrl+Left',
        action :{$: 'studio.open-control-tree' }
      }
    ]
  }
})

jb.component('studio.focus-on-first-property', {
  type: 'action',
  params: [{ id: 'delay', as: 'number', defaultValue: 100 }],
  impl: (ctx,delay) => {
    jb.delay(delay).then ( _=> {
    var elem =  Array.from(document.querySelectorAll('[dialogid="studio-properties"] input,textarea,select'))
      .filter(e => e.getAttribute('type') != 'checkbox')[0];
    elem && jb.ui.focus(elem,'studio.focus-on-first-property',ctx);
    })
  }
})

jb.component('studio.open-source-dialog', {
	type: 'action',
	impl :{$: 'open-dialog',
			modal: true,
			title: 'Source',
        	style :{$: 'dialog.dialog-ok-cancel' },
			content :{$: 'text',
				text :{$: 'studio.comp-source'},
				style:{$: 'text.codemirror'}
			},
		}
})

jb.component('studio.properties', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'group',
    controls: [
      {$: 'group',
        title: 'accordion',
        style :{$: 'group.studio-properties-accordion' },
        controls: [
          {$: 'group',
            remark: 'properties',
            title :{
              $pipeline: [
                {$: 'count',
                  items :{$: 'studio.non-control-children', path: '%$path%' }
                },
                'Properties (%%)'
              ]
            },
            style :{$: 'property-sheet.studio-properties' },
            controls: [
              {$: 'dynamic-controls',
                controlItems :{$: 'studio.non-control-children', path: '%$path%' },
                genericControl :{$: 'studio.property-field', path: '%$controlItem%' }
              }
            ]
          },
          {$: 'group',
            remark: 'features',
            title :{
              $pipeline: [
                {$: 'count',
                  items :{$: 'studio.val', path: '%$path%~features' }
                },
                'Features (%%)'
              ]
            },
            controls :{$: 'studio.property-array', path: '%$path%~features' }
          }
        ],
        features: [
          {$: 'group.dynamic-titles' },
          {$: 'studio.watch-path', path: '%$path%~features' },
          {$: 'hidden',
            showCondition :{$: 'studio.has-param',
              remark: 'not a control',
              path: '%$path%',
              param: 'features'
            }
          }
        ]
      },
      {$: 'button',
        title: 'new feature',
        action :{$: 'studio.open-new-profile-dialog',
          path: '%$path%~features',
          type: 'feature',
          onClose: ctx =>
            ctx.vars.PropertiesDialog.openFeatureSection()
        },
        style :{$: 'button.href' },
        features :{$: 'css.margin', top: '20', left: '5' }
      }
    ],
    features :{$: 'var',
      name: 'PropertiesDialog',
      value :{$: 'object' },
      mutable: false
    }
  }
})

jb.component('studio.properties-in-tgp',{
  type: 'control',
  params: [ {id: 'path', as: 'string' } ],
  impl :{$: 'group',
    style :{$: 'property-sheet.studio-properties-in-tgp'},
    controls :{$: 'dynamic-controls',
        controlItems :{$: 'studio.non-control-children', path: '%$path%', includeFeatures: true },
        genericControl :{$: 'studio.property-field', path: '%$controlItem%' }
    },
    features:{$: 'group.auto-focus-on-first-input'}
  }
})

jb.component('studio.property-field', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'control.first-succeeding',
    $vars: {
      paramType :{$: 'studio.param-type', path: '%$path%' },
      paramDef :{$: 'studio.param-def', path: '%$path%' }
    },
    title :{$: 'studio.prop-name', path: '%$path%' },
    controls: [
      {$: 'control-with-condition',
        condition :{
          $and: [
            {
              $not :{$: 'is-of-type',
                type: 'string,number,boolean,undefined',
                obj :{$: 'studio.val', path: '%$path%' }
              }
            },
            {$: 'studio.is-of-type', path: '%$path%', type: 'data,boolean' }
          ]
        },
        control :{$: 'studio.property-script', path: '%$path%' }
      },
      {$: 'control-with-condition',
        condition :{
          $and: [
            {$: 'is-of-type',
              type: 'array',
              obj :{$: 'studio.val', path: '%$path%' }
            },
            {$: 'studio.is-of-type', path: '%$path%', type: 'action' }
          ]
        },
        control :{$: 'studio.property-script', path: '%$path%' }
      },
      {$: 'control-with-condition',
        condition: '%$paramDef/options%',
        control :{$: 'studio.property-enum', path: '%$path%' }
      },
      {$: 'control-with-condition',
        condition: '%$paramDef/as%=="number"',
        control :{$: 'studio.property-slider', path: '%$path%' }
      },
      {$: 'control-with-condition',
        condition :{
          $and: [
            '%$paramDef/as%=="boolean"',
            {
              $or: [
                {$: 'in-group',
                  group :{ $list: ['true', 'false'] },
                  item :{$: 'studio.val', path: '%$path%' }
                },
                {$: 'isEmpty',
                  item :{$: 'studio.val', path: '%$path%' }
                }
              ]
            }
          ]
        },
        control :{$: 'studio.property-boolean', path: '%$path%' }
      },
      {$: 'control-with-condition',
        condition :{$: 'studio.is-of-type', path: '%$path%', type: 'data,boolean' },
        control :{$: 'studio.property-primitive', path: '%$path%' }
      },
      {$: 'studio.property-tgp', path: '%$path%' }
    ],
    features: [
      {$: 'studio.property-toolbar-feature', path: '%$path%' },
      {$: 'studio.watch-typeof-script', path: '%$path%' }
    ]
  }
})

// jb.component('studio.property-field2', {
// 	type: 'control',
// 	params: [
// 		{ id: 'path', as: 'string' },
// 	],
// 	impl: function(context,path) {
// 		var fieldPT = 'studio.property-label';

//     var st = jb.studio;
// 		var val = st.valOfPath(path);
// 		var valType = typeof val;
// 		var paramDef = st.paramDef(path);
// 		if (!paramDef)
// 			jb.logError('property-field: no param def for path '+path);
// 		if (valType == 'function')
// 			fieldPT = 'studio.property-javascript';
// 		else if (paramDef.as == 'number')
// 			fieldPT = 'studio.property-slider';
// 		else if (paramDef.options)
// 			fieldPT = 'studio.property-enum';
// 		else if ( ['data','boolean'].indexOf(paramDef.type || 'data') != -1) {
// 			if ( st.compNameOfPath(path) || valType == 'object')
// 				fieldPT = 'studio.property-script';
// 			else if (paramDef.type == 'boolean' && (valType == 'boolean' || val == null))
// 				fieldPT = 'studio.property-boolean';
// 			else
// 				fieldPT = 'studio.property-primitive';
// 		}
// 		else if ( (paramDef.type || '').indexOf('[]') != -1 && isNaN(Number(path.split('~').pop())))
// 			fieldPT = 'studio.property-script';
// 		else
// 			fieldPT = 'studio.property-tgp';

// 		return context.run({ $: fieldPT, path: path });
// 	}
// })

jb.component('studio.property-label',{
	type: 'control',
	params: [ {id: 'path', as: 'string' } ],
	impl :{$: 'label',
		title :{$: 'studio.prop-name', path: '%$path%' },
	}
});

jb.component('studio.property-script', {
  type: 'control',
  params: [
    { id: 'path', as: 'string' }
  ],
  impl :{$: 'group',
    controls :{$: 'button',
        title :{$: 'studio.data-script-summary', path: '%$path%' },
        action :{$: 'studio.open-jb-editor',path: '%$path%' } ,
        style :{$: 'button.studio-script'}
    }
  }
})

jb.component('studio.property-js-script', {
  type: 'control',
  params: [
    { id: 'path', as: 'string' }
  ],
  impl :{$: 'group',
    controls :{$: 'button',
        title :{$: 'studio.js-script-summary', path: '%$path%' },
        action :{$: 'studio.open-js-editor',path: '%$path%' } ,
        style :{$: 'button.studio-script'}
    }
  }
})

jb.component('studio.data-script-summary', {
  type: 'data',
  params: [
    { id: 'path', as: 'string' }
  ],
  impl: (ctx,path) => {
    var st = jb.studio;
    return jb.prettyPrint(st.valOfPath(path));
  	// var val = st.valOfPath(path);
  	// if (st.compNameOfPath(path))
  	// 	return st.compNameOfPath(path);
  	// if (Array.isArray(val))
  	// 	return st.prettyPrint(val);
  	// if (typeof val == 'function')
  	// 	return 'javascript';
  }
})

jb.component('studio.property-boolean', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'editable-boolean',
    databind :{$: 'studio.ref', path: '%$path%' },
    style :{$: 'editable-boolean.mdl-slide-toggle' },
    features: [
//      {$: 'studio.undo-support', path: '%$path%' },
//      {$: 'studio.property-toolbar-feature', path: '%$path%' },
      {$: 'css.width', width: '150' }
    ]
  }
})

jb.component('studio.property-enum', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'picklist',
    databind :{$: 'studio.ref', path: '%$path%' },
    options :{$: 'studio.enum-options', path: '%$path%' },
    style :{$: 'picklist.native-md-look' },
    features: {$: 'css.width', width: '370' }
  }
})

jb.component('studio.property-slider', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'editable-number',
    $vars: {
      paramDef :{$: 'studio.param-def', path: '%$path%' }
    },
    databind :{$: 'studio.ref', path: '%$path%' },
    style :{$: 'editable-number.slider', width: '120' },
    min :{ $firstSucceeding: ['%$paramDef/min%', 0] },
    max :{ $firstSucceeding: ['%$paramDef/max%', 100] },
    step :{ $firstSucceeding: ['%$paramDef/step%', 1] },
    features :{$: 'css',
      width: '212',
      css: `>input-slider { width: 110px; }
>.input-text { width: 20px; padding-right: 15px; margin-top: 2px; }`
    }
  }
})

jb.component('studio.property-tgp', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'group',
    controls: [
      {$: 'group',
        title: 'header',
        style :{$: 'layout.horizontal', spacing: '0' },
        controls: [
          {$: 'editable-boolean',
            databind: '%$userExpanded%',
            style :{$: 'editable-boolean.expand-collapse' },
            features: [
              {$: 'studio.watch-path', path: '%$path%', includeChildren: true },
              {$: 'css',
                css: '{ position: absolute; margin-left: -20px; margin-top: 5px }'
              },
              {$: 'hidden',  showCondition :{$: 'studio.properties-expanded-relevant', path: '%$path%' } },
            ]
          },
          {$: 'group',
            controls: [{$: 'studio.pick-profile', path: '%$path%' }],
            features: [{$: 'css.width', width: '150' }]
          }
        ],
        features :{$: 'css', css: '{ position: relative }' }
      },
      {$: 'group',
        title: 'inner',
        controls :{$: 'studio.properties-in-tgp', path: '%$path%' },
        features: [
          {$: 'studio.watch-path', path: '%$path%' },
          {$: 'watch-ref', ref: '%$userExpanded%'  },
          {$: 'feature.if', showCondition :{$: 'studio.properties-show-expanded', path: '%$path%' } },
          {$: 'css',
            css: '{ margin-top: 9px; margin-left: -83px; margin-bottom: 4px;}'
          },
        ]
      }
    ],
    features: [
      {$: 'var', name: 'userExpanded', value : false, mutable: true },
    ]
  }
})

jb.component('studio.properties-expanded-relevant', {
	type: 'boolean',
	params: [{ id: 'path', as: 'string', essential: true }],
	impl:{ $and: [
		{
			$notEmpty :{$: 'studio.non-control-children', path: '%$path%' }
		},
		{
			$notEmpty :{$: 'studio.val', path: '%$path%' }
		},
		{$: 'not-equals',
			item1 :{$: 'studio.comp-name', path: '%$path%' },
			item2: 'custom-style'
		}
	]}
})

jb.component('studio.properties-show-expanded', {
	type: 'boolean',
	params: [{ id: 'path', as: 'string', essential: true }],
	impl:{ $and: [
		{$: 'studio.properties-expanded-relevant', path: '%$path%'},
		{ $or: [ {$: 'studio.is-new', path: '%$path%' },	'%$userExpanded%' ] },
	]}
})

jb.component('studio.property-tgp-in-array', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'group',
    controls: [
      {$: 'group',
        style :{$: 'layout.flex', align: 'space-between' },
        controls: [
          {$: 'editable-boolean',
            databind: '%$expanded%',
            style :{$: 'editable-boolean.expand-collapse' },
            features: [{$: 'css.padding', top: '4' }]
          },
          {$: 'label',
            title :{$: 'pipeline',
              items: [
                {$: 'studio.comp-name', path: '%$path%' },
                {$: 'suffix', separator: '.', text: '%%' }
              ]
            },
            style :{$: 'label.p' },
            features: [
              {$: 'css.width', width: '100' },
              {$: 'css.class', class: 'drag-handle' }
            ]
          },
          {$: 'label',
            title :{$: 'studio.summary', path: '%$path%' },
            style :{$: 'label.p' },
            features: [
              {$: 'css.width', width: '335' },
              {$: 'studio.watch-path', path: '%$path%', includeChildren: true }
            ]
          },
          {$: 'studio.property-toolbar',
            features :{$: 'css', css: '{ position: absolute; left: 20px }' },
            path: '%$path%'
          }
        ],
        features: [{$: 'studio.disabled-support', path: '%$path%' }]
      },
      {$: 'group',
        controls :{$: 'studio.properties-in-tgp', path: '%$path%' },
        features: [
          {$: 'feature.if', showCondition: '%$expanded%'},
          {$: 'watch-ref', ref: '%$expanded%',  },
          {$: 'css', css: '{ margin-left: 10px; margin-bottom: 4px;}' },
          {$: 'studio.disabled-support', path: '%$path%' }
        ]
      }
    ],
    features: [
      {$: 'css.margin', left: '-100' },
      {$: 'var',
        name: 'expanded',
        value :{$: 'studio.is-new', path: '%$path%' },
        mutable: true
      },
      {$: 'studio.watch-path',
        path: '%$path%',
//        includeChildren: 'true'
      }
    ]
  }
})

jb.component('studio.property-array', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'group',
    style :{$: 'layout.vertical', spacing: '7' },
    controls: [
      {$: 'group',
        title: 'items',
        controls: [
          {$: 'itemlist',
            items :{$: 'studio.as-array-children', path: '%$path%' },
            controls :{$: 'group',
              style :{$: 'property-sheet.studio-plain' },
              controls :{$: 'studio.property-tgp-in-array', path: '%$arrayItem%' }
            },
            itemVariable: 'arrayItem',
            features: [
              {$: 'studio.watch-path', path: '%$path%', },
              {$: 'itemlist.divider' },
              {$: 'itemlist.drag-and-drop' }
            ]
          }
        ]
      },
      // {$: 'button',
      //   title: 'new feature',
      //   action :{$: 'studio.open-new-profile-dialog', type: 'feature', path: '%$path%' },
      //   style :{$: 'button.href' },
      //   features :{$: 'css.margin', top: '20', left: '20' }
      // }
    ],
  }
})


jb.component('studio.tgp-path-options',{
	type: 'picklist.options',
	params: [
		{ id: 'path', as: 'string' },
	],
	impl: (context,path) =>
		[{code:'',text:''}]
			.concat(jb.studio.PTsOfPath(path).map(op=> ({ code: op, text: op})))
})
;

(function() {
var st = jb.studio;

jb.component('studio.pick', {
	type: 'action',
	params: [
		{ id: 'from', options: 'studio,preview', as: 'string', defaultValue: 'preview'},
		{ id: 'onSelect', type:'action', dynamic:true }
	],
	impl :{$: 'open-dialog',
		$vars: { pickSelection: ctx =>
      ctx.vars.pickSelection || {} },
		style: {$: 'dialog.studio-pick-dialog', from: '%$from%'},
		content: {$: 'label', title: ''}, // dummy
		onOK: ctx =>
			ctx.componentContext.params.onSelect(ctx.setData(ctx.vars.pickSelection.ctx))
	 }
})

jb.component('dialog.studio-pick-dialog', {
	hidden: true,
	type: 'dialog.style',
	params: [
		{ id: 'from', as: 'string' },
	],
	impl: {$: 'custom-style',
	      template: (cmp,state,h) => h('div',{ class: 'jb-dialog' },[
h('div',{ class: 'edge top', style: { width: state.width + 'px', top: state.top + 'px', left: state.left + 'px' }}) ,
h('div',{ class: 'edge left', style: { height: state.height +'px', top: state.top + 'px', left: state.left + 'px' }}),
h('div',{ class: 'edge right', style: { height: state.height +'px', top: state.top + 'px', left: (state.left + state.width) + 'px' }}) ,
h('div',{ class: 'edge bottom', style: { width: state.width + 'px', top: (state.top + state.height) +'px', left: state.left + 'px' }}) ,
h('div',{ class: 'title' + (state.titleBelow ? ' bottom' : ''), style: { top: state.titleTop + 'px', left: state.titleLeft + 'px'} },[
			h('div',{ class: 'text'},state.title),
			h('div',{ class: 'triangle'}),
	])]),
		css: `
>.edge {
	z-index: 6001;
	position: absolute;
	background: red;
	box-shadow: 0 0 1px 1px gray;
	width: 1px; height: 1px;
	cursor: pointer;
}
>.title {
	z-index: 6001;
	position: absolute;
	font: 14px arial; padding: 0; cursor: pointer;
	transition:top 100ms, left 100ms;
}
>.title .triangle {	width:0;height:0; border-style: solid; 	border-color: #e0e0e0 transparent transparent transparent; border-width: 6px; margin-left: 14px;}
>.title .text {	background: #e0e0e0; font: 14px arial; padding: 3px; }
>.title.bottom .triangle { background: #fff; border-color: transparent transparent #e0e0e0 transparent; transform: translateY(-28px);}
>.title.bottom .text { transform: translateY(6px);}
				`,
			features: [
				{ $: 'dialog-feature.studio-pick', from: '%$from%' },
			]
	}
})


jb.component('dialog-feature.studio-pick', {
	type: 'dialog-feature',
	params: [
		{ id: 'from', as: 'string' },
	],
	impl: ctx =>
	({
	  disableChangeDetection: true,
      init: cmp=> {
		  var _window = ctx.params.from == 'preview' ? st.previewWindow : window;
		  var previewOffset = ctx.params.from == 'preview' ? document.querySelector('#jb-preview').getBoundingClientRect().top : 0;
		  cmp.titleBelow = false;

		  var mouseMoveEm = jb.rx.Observable.fromEvent(_window.document, 'mousemove');
		  var userPick = jb.rx.Observable.fromEvent(document, 'mousedown');
		  var keyUpEm = jb.rx.Observable.fromEvent(document, 'keyup');
		  if (st.previewWindow) {
		  	userPick = userPick.merge(jb.rx.Observable.fromEvent(st.previewWindow.document, 'mousedown'));
		  	keyUpEm = keyUpEm.merge(jb.rx.Observable.fromEvent(st.previewWindow.document, 'keyup'));
		  };

		  mouseMoveEm
		  	.debounceTime(50)
		  	.takeUntil(
		  		keyUpEm.filter(e=>
		  			e.keyCode == 27)
		  			  .merge(userPick))
		  	.do(e=>{
		  		if (e.keyCode == 27)
		  			ctx.vars.$dialog.close({OK:false});
		  	})
		  	.map(e=>
		  		eventToElem(e,_window))
		  	.filter(x=> x)
		  	.do(profElem=> {
          if (profElem.getAttribute) {
		  		    ctx.vars.pickSelection.ctx = _window.jb.ctxDictionary[profElem.getAttribute('jb-ctx')];
              showBox(cmp,profElem,_window,previewOffset);
          }
		  	})
        .last()
		  	.subscribe(x=> {
		  		ctx.vars.$dialog.close({OK:true});
		  		jb.delay(200).then(_=> {
            if (st.previewWindow && st.previewWindow.getSelection())
              st.previewWindow.getSelection().innerHTML = ''
            })
		  	})
		}
	})
})

function pathFromElem(_window,profElem) {
	try {
		return _window.jb.ctxDictionary[profElem.getAttribute('jb-ctx') || profElem.parentElement.getAttribute('jb-ctx')].path;
	} catch (e) {
		return '';
	}
	//profElem.attr('jb-path');
}

function eventToElem(e,_window) {
	var mousePos = {
		x: e.pageX - document.body.scrollLeft, y: e.pageY - - document.body.scrollTop
	};
	var el = _window.document.elementFromPoint(mousePos.x, mousePos.y);
	if (!el) return;
	var results = [el].concat(jb.ui.parents(el))
		.filter(e =>
			e && e.getAttribute && e.getAttribute('jb-ctx') );
	if (results.length == 0) return [];

	// promote parents if the mouse is near the edge
	var first_result = results.shift(); // shift also removes first item from results!
	var edgeY = Math.max(3,Math.floor(jb.ui.outerHeight(first_result) / 10));
	var edgeX = Math.max(3,Math.floor(jb.ui.outerWidth(first_result) / 10));

	var orderedResults = results.filter(elem=>{
		return Math.abs(mousePos.y - jb.ui.offset(elem).top) < edgeY || Math.abs(mousePos.x - jb.ui.offset(elem).left) < edgeX;
	}).concat([first_result]);
	return orderedResults[0];
}

function showBox(cmp,profElem,_window,previewOffset) {
  var profElem_offset = jb.ui.offset(profElem);
	if (profElem_offset == null || jb.ui.offset(document.querySelector('#jb-preview')) == null)
		return;

	cmp.setState({
		top: previewOffset + profElem_offset.top,
		left: profElem_offset.left,
		width: jb.ui.outerWidth(profElem) == jb.ui.outerWidth(_window.document.body) ? jb.ui.outerWidth(profElem) -10 : cmp.width = jb.ui.outerWidth(profElem),
		height: jb.ui.outerHeight(profElem),
		title: st.shortTitle(pathFromElem(_window,profElem)),
		titleTop: previewOffset + profElem_offset.top - 20,
		titleLeft: profElem_offset.left
	});
}

jb.studio.getOrCreateHighlightBox = function() {
  var _window = st.previewWindow || window;
  if (!_window.document.querySelector('#preview-box')) {
    var elem = _window.document.createElement('div');
    elem.setAttribute('id','preview-box');
    !_window.document.body.appendChild(elem);
  }
  return _window.document.querySelector('#preview-box');
}

jb.studio.highlight = function(elems) {
	//var boxes = [];
	var html = elems.map(el => {
			var offset = jb.ui.offset(el);
			var width = jb.ui.outerWidth(el);
      if (width == jb.ui.outerWidth(document.body)) width -= 10;
      return `<div class="jbstudio_highlight_in_preview jb-fade-500ms" style="opacity: 0.5; position: absolute; background: rgb(193, 224, 228); border: 1px solid blue; zIndex: 5000;
      width: ${width}px; left: ${offset.left}px;top: ${offset.top}px; height: ${jb.ui.outerHeight(el)}px"></div>`
	}).join('');
  var box = jb.studio.getOrCreateHighlightBox();
  jb.ui.removeClass(box,'jb-fade-3s-transition');
  box.innerHTML = html;
  jb.delay(1).then(_=> jb.ui.addClass(box,'jb-fade-3s-transition'));
  jb.delay(1000).then(_=>jb.studio.getOrCreateHighlightBox().innerHTML = ''); // clean after the fade animation
}

jb.component('studio.highlight-in-preview',{
	type: 'action',
	params: [
		{ id: 'path', as: 'string' }
	],
	impl: (ctx,path) => {
		var _window = st.previewWindow || window;
		if (!_window) return;
		var elems = Array.from(_window.document.querySelectorAll('[jb-ctx]'))
			.filter(e=>{
				var _ctx = _window.jb.ctxDictionary[e.getAttribute('jb-ctx')];
				var callerPath = _ctx && _ctx.componentContext && _ctx.componentContext.callerPath;
				return callerPath == path || (_ctx && _ctx.path == path);
			})

		if (elems.length == 0) // try to look in studio
			elems = Array.from(document.querySelectorAll('[jb-ctx]'))
			.filter(e=> {
				var _ctx = jb.ctxDictionary[e.getAttribute('jb-ctx')];
				return _ctx && _ctx.path == path
			})

		jb.studio.highlight(elems);
  }
})

st.closestCtxInPreview = path => {
	var _window = st.previewWindow || window;
	if (!_window) return;
	var closest,closestElem;
	var elems = Array.from(_window.document.querySelectorAll('[jb-ctx]'));
	for(var i=0;i<elems.length;i++) {
		var _ctx = _window.jb.ctxDictionary[elems[i].getAttribute('jb-ctx')];
		if (!_ctx) continue; //  || !st.isOfType(_ctx.path,'control'))
		if (_ctx.path == path)
			return {ctx: _ctx, elem: elems[i]} ;
		if (path.indexOf(_ctx.path) == 0 && (!closest || closest.path.length < _ctx.path.length)) {
			closest = _ctx; closestElem = elems[i]
		}
	}
	return {ctx: closest, elem: closestElem};
}

// st.refreshPreviewOfPath = path => {
// 	var closest = st.closestCtxInPreview(path);
// 	if (!closest.ctx) return;
// 	var closest_path = closest.ctx.path;
// 	var _window = st.previewWindow || window;
// 	Array.from(_window.document.querySelectorAll('[jb-ctx]'))
// 		.map(el=> ({el:el, ctx: _window.jb.ctxDictionary[el.getAttribute('jb-ctx')]}))
// 		.filter(elCtx => (elCtx.ctx||{}).path == closest_path )
// 		.forEach(elCtx=>{
// 			try {
// 			elCtx.ctx.profile = st.valOfPath(elCtx.ctx.path); // recalc last version of profile
// 			if (elCtx.ctx.profile)
// 				jb.ui.refreshComp(elCtx.ctx,elCtx.el);
// 			} catch(e) { jb.logException(e) };
// 		})
// }

})()
;

(function() {
var st = jb.studio;
var _window = window.parent || window;
var elec_remote = _window.require && _window.require('electron').remote;
var fs = elec_remote && elec_remote.require('fs');
var jb_projectFolder = elec_remote && elec_remote.getCurrentWindow().jb_projectFolder;

jb.component('studio.save-components', {
	type: 'action,has-side-effects',
	params: [
		{ id: 'force',as: 'boolean', type: 'boolean' }
	],
	impl : (ctx,force) =>
		jb.rx.Observable.from(Object.getOwnPropertyNames(st.previewjb.comps))
			.filter(id=>id.indexOf('$jb') != 0)
			.filter(id=>st.previewjb.comps[id] != st.serverComps[id])
			.concatMap(id=>{
				var original = st.serverComps[id] ? jb.prettyPrintComp(id,st.serverComps[id]) : '';
				st.message('saving ' + id + '...');
				if (force && !original)
					original = `jb.component('${id}', {`;
        var project = ctx.exp('%$studio/project%');

        if (fs) {
            return [{message: saveComp(st.compAsStr(id),original,id,project,force,jb_projectFolder && jb_projectFolder(project),''), type: 'success'}]
        } else { // via http
          var headers = new Headers();
          headers.append("Content-Type", "application/json; charset=UTF-8");
          return fetch(`/?op=saveComp&comp=${id}&project=${project}&force=${force}`,
            {method: 'POST', headers: headers, body: JSON.stringify({ original: original, toSave: st.compAsStr(id) }) })
          .then(res=>res.json())
          .then(res=>({ res: res , id: id }))
        }
			})
			.catch(e=>{
				st.message('error saving: ' + (typeof e == 'string' ? e : e.e), true);
				return jb.logException(e,'error while saving ' + e.id) || []
			})
			.subscribe(entry=>{
				var result = entry.res || entry;
				st.message((result.type || '') + ': ' + (result.desc || '') + (result.message || ''), result.type != 'success');
				if (result.type == 'success')
					st.serverComps[entry.id] = st.previewjb.comps[entry.id];
			})
});

// directly saving the comp - duplicated in studio-server
function saveComp(toSave,original,comp,project,force,projectDir,destFileName) {
    var _iswin = /^win/.test(process.platform);
    var projDir = projectDir;

    if (comp.indexOf('studio.') == 0 && project == 'studio-helper')
      projDir = 'projects/studio';

    if (!original) { // new comp
      var srcPath = `${projectDir}/${destFileName || (project+'.js')}`;
      try {
        var current = '' + fs.readFileSync(srcPath);
        var toStore =  current + '\n\n' + toSave;
        var cleanNL = toStore.replace(/\r/g,'');
        if (_iswin)
          cleanNL = cleanNL.replace(/\n/g,'\r\n');
        fs.writeFileSync(srcPath,cleanNL);
        return `component ${comp} added to ${srcPath}`;
      } catch (e) {
        throw `can not store component ${comp} in path ${srcPath}`
      }
    }

    var comp_found = '';
//        console.log(original);
    fs.readdirSync(projDir)
      .filter(x=>x.match(/\.js$/) || x.match(/\.ts$/))
      .forEach(srcFile=> {
          var srcPath = projDir+'/'+srcFile;
          var source = ('' + fs.readFileSync(srcPath)).replace(/\r/g,'').split('\n');
          var toFind = original.replace(/\r/g,'').split('\n');
          var replaceWith = toSave.replace(/\r/g,'').split('\n');
          var found = findSection(source,toFind,srcFile);
          if (found) {
            //console.log('splice',source,found.index,found.length,replaceWith);
            source.splice.apply(source, [found.index+1, found.length-1].concat(replaceWith.slice(1)));
            var newContent = source.join(_iswin ? '\r\n' : '\n');
            fs.writeFileSync(srcPath,newContent);
            comp_found = `component ${comp} saved to ${srcPath} at ${JSON.stringify(found)}`;
          }
      })

    if (comp_found)
      return comp_found
    else
      throw `Can not find component ${comp} in project`;

    function findSection(source,toFind,srcFile) {
      var index = source.indexOf(toFind[0]);
      // if (index == -1)
      //   index = source.indexOf(toFind[0].replace('jb_','jb.'));
      if (index != -1 && force) {// ignore content - just look for the end
        for(end_index=index;end_index<source.length;end_index++)
          if ((source[end_index]||'').match(/^}\)$/m))
            return { index: index, length: end_index - index +1}
      } else if (index != -1 && compareArrays(source.slice(index,index+toFind.length),toFind)) {
          return { index: index, length: toFind.length }
      } else if (index == -1) {
        return false;
      } else {
        // calc error message
        var err = '';
        var src = source.slice(index,index+toFind.length);
        console.log('origin not found at file ' + srcFile);
        src.forEach(l=>console.log(l));
        toFind.forEach((line,index) => {
          if (line != src[index])
            console.log(index + '-' +line + '#versus source#' + src[index]);
        })

        throw `${comp} found with a different source, use "force save" to save. ${err}`;
      }
    }
    function compareArrays(arr1,arr2) {
      return arr1.join('\n') == arr2.join('\n')
    }
}


})();
;

jb.component('studio.open-project', {
  type: 'action', 
  impl :{$: 'open-dialog', 
    title: 'Open project', 
    style :{$: 'dialog.dialog-ok-cancel', okLabel: 'OK', cancelLabel: 'Cancel' }, 
    content :{$: 'studio.choose-project' }
  }
})

jb.component('studio.goto-project', {
  type: 'action', 
  impl :{$: 'runActions', 
    actions: [
      {$: 'goto-url', 
        url: '/project/studio/%%', 
        target: 'new tab'
      }, 
      {$: 'dialog.close-containing-popup' }
    ]
  }
})

jb.component('studio.choose-project', {
  type: 'control', 
  impl :{$: 'group', 
    title: 'itemlist-with-find', 
    controls: [
      {$: 'itemlist-container.search', features: {$: 'css.width', width: '250'} },
      {$: 'itemlist', 
        items :{
          $pipeline: [
            '%projects%', 
            {$: 'itemlist-container.filter' }, 
          ]
        }, 
        features: [
            { $: 'itemlist.selection' }, 
            { $: 'itemlist.keyboard-selection', autoFocus: true, onEnter :{$: 'studio.goto-project' } },
            { $: 'watch-ref', ref: '%$itemlistCntrData/search_pattern%', }
        ],
        controls :{$: 'button', 
          title :{$: 'highlight', 
            base: '%%', 
            highlight: '%$itemlistCntrData/search_pattern%', 
          }, 
          action :{$: 'studio.goto-project' }, 
          style :{$: 'button.mdl-flat-ripple' }, 
          features :{$: 'css', css: '{ text-align: left; width: 250px }' }
        }, 
//        style :{$: 'itemlist.ul-li' }, 
//        itemVariable: 'project'
      }
    ], 
    features: [
      {$: 'group.wait', for :{$: 'http.get', url: '/?op=projects', json: 'true' }},
      {$: 'css.padding', top: '15', left: '15' },
      {$: 'group.itemlist-container' }, 
    ]
  }
})

;

jb.component('studio.property-toolbar-feature', {
  type: 'feature',
  params: [
    { id: 'path', as: 'string' }
  ],
  impl : {$list: [
    {$: 'field.toolbar',
        toolbar :{$: 'studio.property-toolbar', path: '%$path%' }
    },
    {$: 'studio.disabled-support', path: '%$path%' }
  ]}
})

jb.component('studio.property-toolbar', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'button',
    title: 'more...',
    action :{$: 'studio.open-property-menu', path: '%$path%' },
    style :{$: 'studio.property-toolbar-style' },
//    features :{$: 'css.margin', top: '5', left: '4' }
  }
})

jb.component('studio.open-property-menu', {
  type: 'action',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'menu.open-context-menu',
    menu :{$: 'menu.menu',
		$vars: {
	      compName :{$: 'studio.comp-name', path: '%$path%' }
	    },
      options: [
        {$: 'studio.style-editor-options', path: '%$path%' },
        {$: 'menu.action',
          title: 'multiline edit',
          action :{$: 'studio.open-multiline-edit', path: '%$path%' },
          showCondition :{$: 'equals',
            item1 :{ $pipeline: [{$: 'studio.param-def', path: '%$path%' }, '%as%'] },
            item2: 'string'
          }
        },
        {$: 'menu.action',
          title: 'Goto %$compName%',
          action :{$: 'studio.goto-path', path: '%$compName%' },
          showCondition: '%$compName%'
        },
        {$: 'menu.action',
          title: 'Inteliscript editor',
          action :{$: 'studio.open-jb-editor', path: '%$path%' },
          icon: 'code'
        },
        {$: 'menu.action',
          title: 'Javascript editor',
          action :{$: 'studio.edit-source', path: '%$path%' },
          icon: 'code',
          shortcut: 'Ctrl+J'
        },
        {$: 'studio.goto-editor-options', path: '%$path%' },
        {$: 'menu.action',
          title: 'Delete',
          action :{$: 'studio.delete', path: '%$path%' },
          icon: 'delete',
          shortcut: 'Delete'
        },
        {$: 'menu.action',
          title :{
            $if :{$: 'studio.disabled', path: '%$path%' },
            then: 'Enable',
            else: 'Disable'
          },
          action :{$: 'studio.toggle-disabled', path: '%$path%' },
          icon: 'do_not_disturb',
          shortcut: 'Ctrl+X'
        }
      ]
    }
  }
})
;


jb.component('studio.new-project', {
	type: 'action,has-side-effects',
	params: [
		{ id: 'name',as: 'string' },
    { id: 'onSuccess', type: 'action', dynamic: true }
	],
	impl : (ctx,name) => {
    var request = {
      project: name,
      files: [
        { fileName: `${name}.js`, content: `
jb.component('${name}.main', {
  type: 'control',
  impl :{$: 'group', controls: [ {$: 'button', title: 'my button'}] }
})`
        },
        { fileName: `${name}.html`, content: `
<!DOCTYPE html>
<head>
  <script type="text/javascript">
    startTime = new Date().getTime();
  </script>
  <script type="text/javascript" src="/src/loader/jb-loader.js" modules="common,ui-common"></script>
  <script type="text/javascript" src="/projects/${name}/${name}.js"></script>
  <script1 type="text/javascript" src="/projects/${name}/samples.js"></script1>
</head>
<body>
<div id="main"> </div>
<script>
  jb.ui.renderWidget({$:'${name}.main'},document.getElementById('main'))
</script>
</body>
</html>
` },
      ]
    };
    var headers = new Headers();
    headers.append("Content-Type", "application/json; charset=UTF-8");
    return fetch(`/?op=createProject`,{method: 'POST', headers: headers, body: JSON.stringify(request) })
    .then(r =>
        r.json())
    .then(res=>{
        if (res.type == 'error')
            return jb.studio.message(`error creating project ${name}: ` + (e && e.desc));
        jb.studio.message(`project ${name} created`);
        return ctx.params.onSuccess();
    })
    .catch(e => {
      jb.studio.message(`error creating project ${name}: ` + (e && e.desc));
      jb.logException(e)
    })
  }
});

jb.component('studio.open-new-project', {
  type: 'action',
  impl :{$: 'open-dialog',
    title: 'New Project',
    modal: true,
    style :{$: 'dialog.dialog-ok-cancel' },
    content :{$: 'group',
      style :{$: 'group.div' },
      controls: [
        {$: 'editable-text',
          title: 'project name',
          databind: '%$name%',
          style :{$: 'editable-text.mdl-input' },
          features :{$: 'feature.onEnter',
            action :{$: 'dialog.close-containing-popup' }
          }
        }
      ],
      features :{$: 'css.padding', top: '14', left: '11' }
    },
    onOK:{$: 'studio.new-project', name: '%$name%', onSuccess: {$:'goto-url', url: '/project/studio/%$name%/'}},
    features : [
      {$: 'var', name: 'name', mutable: true },
      {$: 'dialog-feature.auto-focus-on-first-input' }
    ]
  }
})
;

jb.component('studio.components-cross-ref',{
	type: 'data',
	impl: ctx => {
	  var _jb = jb.studio.previewjb;
	  jb.studio.scriptChange.subscribe(_=>_jb.statistics = null);
	  if (_jb.statistics) return _jb.statistics;

	  var refs = {}, comps = _jb.comps;

      Object.getOwnPropertyNames(comps).filter(k=>comps[k]).forEach(k=>
      	refs[k] = {
      		refs: calcRefs(comps[k].impl).filter((x,index,self)=>self.indexOf(x) === index) ,
      		by: []
      });
      Object.getOwnPropertyNames(comps).filter(k=>comps[k]).forEach(k=>
      	refs[k].refs.forEach(cross=>
      		refs[cross] && refs[cross].by.push(k))
      );

      return _jb.statistics = jb.entries(comps).map(e=>({
          	id: e[0],
          	refs: refs[e[0]].refs,
          	referredBy: refs[e[0]].by,
          	type: e[1].type || 'data',
          	implType: typeof e[1].impl,
          	refCount: refs[e[0]].by.length
          	//text: jb_prettyPrintComp(comps[k]),
          	//size: jb_prettyPrintComp(e[0],e[1]).length
          }));


      function calcRefs(profile) {
      	if (profile == null || typeof profile != 'object') return [];
      	return Object.getOwnPropertyNames(profile).reduce((res,prop)=>
      		res.concat(calcRefs(profile[prop])),[_jb.compName(profile)])
      }
	}
})

jb.component('studio.references', {
	type: 'data',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) => {
	  if (path.indexOf('~') != -1) return [];

    //debugger;refs(jb.studio.previewjb.comps['test.referer1']);

    var res = jb.entries(jb.studio.previewjb.comps)
    	.map(e=>({id: e[0], refs: refs(e[1].impl).map(obj=> e[0]+'~impl~'+ jb.studio.compsRefHandler.pathOfObject(obj,e[1].impl).join('~') ) }))
      .filter(e=>e.refs.length > 0)
    return res;

    function refs(profile) {
    	if (profile && typeof profile == 'object') {
        var subResult = Object.getOwnPropertyNames(profile).reduce((res,prop)=>
      		res.concat(refs(profile[prop])) ,[]);
      	return (profile.$ == path ? [profile] : []).concat(subResult);
      }
      return [];
    }
	}
})

jb.component('studio.goto-references-button', {
  type: 'control',
  params: [
    { id: 'path', as: 'string'},
  ],
  impl :{$: 'control-with-condition',
        $vars: {
          refs :{$: 'studio.references', path: '%$path%' },
          noOfReferences: ctx => ctx.vars.refs.reduce((total,refsInObj)=>total+refsInObj.refs.length,0),
        },
        condition: '%$refs/length%',
        control :{$: 'button',
            title: '%$noOfReferences% references',
            action :{$: 'menu.open-context-menu',
              menu :{$: 'menu.menu', options :{$: 'studio.goto-references-options', path: '%$path%', refs: '%$refs%' } },
            }
        },
      },
})

jb.component('studio.goto-references-menu', {
  type: 'menu.option',
  params: [
    { id: 'path', as: 'string'},
  ],
  impl :{$if: '%$noOfReferences% > 0',
    $vars: {
      refs :{$: 'studio.references', path: '%$path%' },
      noOfReferences: ctx => ctx.vars.refs.reduce((total,refsInObj)=>total+refsInObj.refs.length,0),
    },
    then: {$: 'menu.menu',
      title: '%$noOfReferences% references for %$path%',
      options :{$: 'studio.goto-references-options', path: '%$path%', refs: '%$refs%' } ,
    },
    else: {$: 'menu.action', title: 'no references for %$path%'}
  }
})

jb.component('studio.goto-references-options', {
  type: 'menu.option',
  params: [
    { id: 'path', as: 'string'},
    { id: 'refs', as: 'array' },
  ],
  impl :{$: 'menu.dynamic-options',
        items : '%$refs%',
        genericOption :{$if: '%refs/length% > 1',
          then:{$: 'menu.menu',
            title: '%id% (%refs/length%)',
            options:{$: 'menu.dynamic-options',
              items : '%$menuData/refs%',
              genericOption :{$: 'menu.action',
                title: '%%',
                action :{$: 'studio.open-component-in-jb-editor', path: '%%', fromPath: '%$path%' }
              }
            }
          },
          else: {$: 'menu.action',
            $vars: { compName :{$: 'split', separator: '~', text: '%refs[0]%', part: 'first' } },
            title: '%$compName%',
            action :{$: 'studio.open-component-in-jb-editor', path: '%refs[0]%', fromPath: '%$path%' }
          },
        }
      }
})
;

jb.component('jb-component', {
  type: '*',
  params: [
    { id: 'type', as: 'string', essential: true },
    { id: 'category', as: 'string'},
    { id: 'description', as: 'string'},
    { id: 'params', type: 'jb-param[]'},
    { id: 'impl', dynamicType: '%type%', essential: true  },
  ],
  impl: ctx => ctx.params
})

jb.component('jb-param', {
  type: 'jb-param', singleInType: true,
  params: [
    { id: 'id', as: 'string', essential: true },
    { id: 'type', as: 'string'},
    { id: 'description', as: 'string'},
    { id: 'as', as: 'string', options: 'string,number,boolean,ref,single,array'},
    { id: 'dynamic', type: 'boolean', as: 'boolean'},
    { id: 'essential', type: 'boolean', as: 'boolean'},
    { id: 'composite', type: 'boolean', as: 'boolean'},
    { id: 'singleInType', type: 'boolean', as: 'boolean'},
    { id: 'defaultValue', dynamicType: '%type%' },
  ],
  impl: ctx => ctx.params
})

jb.component('studio.component-header', {
  type: 'control',
  params: [{ id: 'component', as: 'string' }],
  impl :{$: 'group',
    controls: [
      {$: 'label',
        title: '%$component%',
        style :{$: 'label.heading', level: 'h5' }
      },
      {$: 'group',
        title: 'type',
        style :{$: 'layout.horizontal',
          vSpacing: 20,
          hSpacing: 20,
          titleWidth: 100,
          spacing: '20'
        },
        controls: [
          {$: 'editable-text',
            title: 'type',
            databind: '%type%',
            style :{$: 'editable-text.mdl-input', width: '100' }
          },
          {$: 'editable-text',
            title: 'category',
            databind: '%category%',
            style :{$: 'editable-text.mdl-input', width: '250' }
          }
        ]
      },
      {$: 'group',
        title: 'params',
        controls: [
          {$: 'table',
            items: '%params%',
            fields: [
              {$: 'field.control',
                title: '',
                control :{$: 'material-icon',
                  icon: 'home',
                  style :{$: 'icon.material' },
                  features :{$: 'itemlist.drag-handle' }
                },
                width: '60'
              },
              {$: 'field.control',
                title: 'id',
                control :{$: 'editable-text',
                  icon: 'person',
                  title: 'id',
                  databind :{$: 'studio.ref',
                    path :{
                      $pipeline: [
                        ctx => Number(ctx.vars.itemlistCntr.items.indexOf(ctx.data)).toString(),
                        '%$component%~params~%%~id'
                      ]
                    }
                  },
                  style :{$: 'editable-text.mdl-input-no-floating-label',
                    width: '101'
                  }
                }
              },
              {$: 'field.control',
                title: 'type',
                control :{$: 'editable-text',
                  icon: 'person',
                  title: 'type',
                  databind :{$: 'studio.ref',
                    path :{
                      $pipeline: [
                        ctx => Number(ctx.vars.itemlistCntr.items.indexOf(ctx.data)).toString(),
                        '%$component%~params~%%~type'
                      ]
                    }
                  },
                  style :{$: 'editable-text.mdl-input-no-floating-label',
                    width: '100'
                  }
                }
              },
              {$: 'field.control',
                title: 'as',
                control :{$: 'editable-text',
                  icon: 'person',
                  title: 'as',
                  databind: '%as%',
                  style :{$: 'editable-text.mdl-input-no-floating-label',
                    width: '100'
                  }
                }
              },
              {$: 'field.control',
                title: 'dynamic',
                control :{$: 'editable-boolean',
                  icon: 'person',
                  databind: '%dynamic%',
                  style :{$: 'editable-boolean.checkbox', width: '150' },
                  title: 'as',
                  textForTrue: 'yes',
                  textForFalse: 'no'
                }
              },
              {$: 'field.control',
                title: '',
                control :{$: 'button',
                  icon: 'delete',
                  title: 'delete',
                  action :{$: 'itemlist-container.delete', item: '%%' },
                  style :{$: 'button.x', size: '21' },
                  features :{$: 'itemlist.shown-only-on-item-hover' }
                },
                width: '60'
              }
            ],
            style :{$: 'table.mdl',
              classForTable: 'mdl-data-table mdl-shadow--2dp',
              classForTd: 'mdl-data-table__cell--non-numeric'
            },
            watchItems: 'true',
            features: [{$: 'itemlist.drag-and-drop' }]
          },
          {$: 'button',
            title: 'add',
            action :{$: 'itemlist-container.add' },
            style :{$: 'button.mdl-raised' }
          }
        ],
        features :{$: 'group.itemlist-container',
          defaultItem :{$: 'object' }
        }
      }
    ],
    features :{$: 'group.data',
      data :{$: 'studio.ref', path: '%$component%' }
    }
  }
})
;

(function() {
  var st = jb.studio;

jb.component('studio.suggestions-itemlist', {
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'itemlist',
    items: '%$suggestionData/options%',
    controls :{$: 'label',
      title: '%text%',
//      title: {$: 'highlight', base: '%text%', highlight: '%$suggestionData/tail%'},
    },
    watchItems: true,
    features: [
      {$: 'itemlist.no-container'},
      {$: 'itemlist.studio-refresh-suggestions-options',
        path: '%$path%',
//        expressionOnly: true
      },
      {$: 'itemlist.selection',
        databind: '%$suggestionData/selected%',
        onDoubleClick :{$: 'studio.paste-suggestion' },
        autoSelectFirst: true
      },
      {$: 'itemlist.keyboard-selection',
        onEnter : [
          {$: 'studio.paste-suggestion', close: true },
        ],
        autoFocus: false
      },
      {$: 'feature.onKey', code: 39, action :{$: 'studio.paste-suggestion', option: '%$suggestionData/selected%', close: false }}, // right arrow should drill down
      {$: 'css.height', height: '500', overflow: 'auto', minMax: 'max' },
      {$: 'css.width', width: '300', overflow: 'auto', minMax: 'min' },
      {$: 'css',
        css: '{ position: absolute; z-index:1000; background: white }'
      },
      {$: 'css.border', width: '1', color: '#cdcdcd' },
      {$: 'css.padding', top: '2', left: '3', selector: 'li' },
      {$: 'feature.if', showCondition :{ $notEmpty: '%$suggestionData/options%' } },
    ]
  }
})

jb.component('itemlist.studio-refresh-suggestions-options', {
  type: 'feature',
  params: [
    {id: 'path', as: 'string'},
    {id: 'expressionOnly', as: 'boolean'},
  ],
  impl: ctx => ({
      afterViewInit: cmp => {
        var selectionKeySource = cmp.ctx.vars.selectionKeySource;
        var keyup = selectionKeySource.keyup.takeUntil( cmp.destroyed );
        var input = selectionKeySource.input;

        keyup
          .debounceTime(20) // solves timing of closing the floating input
          .startWith(1) // compensation for loosing the first event from selectionKeySource
          .do(e=>jb.logPerformance('suggestions','input: ' + input.value))
          .map(e=>
              input.value).distinctUntilChanged() // compare input value - if input was not changed - leave it. Alt-Space can be used here
          .flatMap(_=>
            getProbe())
          .map(res=>
              res && res.result && res.result[0] && res.result[0].in)
          .map(probeCtx=>
            new st.suggestions(input,ctx.params.expressionOnly).extendWithOptions(probeCtx,ctx.params.path))
          .catch(e=> jb.logException(e,'suggestions') || [])
          .distinctUntilChanged((e1,e2)=>
            e1.key == e2.key) // compare options - if options are the same - leave it.
          .do(e=>jb.logPerformance('suggestions','event',e))
          .takeUntil( cmp.destroyed )
          .subscribe(e=> {
            //   if (input.value.indexOf('=') == 0) {
            //     cmp.ctx.run({$:'write-value', to: {$: 'studio.ref', path: ctx.params.path}, value: '' });
            //     return cmp.ctx.run({$: 'studio.open-new-profile-dialog',
            //       path: ctx.params.path, mode: 'update',
            //       type: {$:'studio.param-type', path: ctx.params.path}
            //    });
            //  }
              cmp.ctx.run({$:'write-value', to: '%$suggestionData/tail%', value: ctx => e.tail })
              cmp.ctx.run({$:'write-value', to: '%$suggestionData/options%', value: ctx => e.options });
              cmp.ctx.run({$:'write-value', to: '%$suggestionData/selected%', value: ctx => e.options[0] });
          });

        function getProbe() {
          if (cmp.probeResult)
            return [cmp.probeResult];
          var probePath = ctx.params.path;
          if (st.valOfPath(probePath) == null)
            jb.writeValue(st.refOfPath(probePath),'',ctx);

          return ctx.run({$: 'studio.probe', path: probePath }).then(res=>cmp.probeResult = res);
        }
      }
  })
})

jb.component('studio.show-suggestions', {
  impl: ctx =>
    new st.suggestions(ctx.data,false).suggestionsRelevant()
})

jb.component('studio.property-primitive', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'group',
//    title :{$: 'studio.prop-name', path: '%$path%' },
    controls: [
      {$: 'editable-text',
        databind :{$: 'studio.ref', path: '%$path%' },
        style :{$: 'editable-text.studio-primitive-text' },
        features: [
//          {$: 'studio.undo-support', path: '%$path%' },
//          {$: 'studio.property-toolbar-feature', path: '%$path%' },
          {$: 'editable-text.helper-popup',
            features :{$: 'dialog-feature.near-launcher-position' },
            control :{$: 'studio.suggestions-itemlist', path: '%$path%' },
            popupId: 'suggestions',
            popupStyle :{$: 'dialog.popup' },
            showHelper :{$: 'studio.show-suggestions' }
          }
        ]
      }
    ],
    features: [
      {$: 'var',
        name: 'suggestionData',
        value :{$: 'object', selected: '', options: [], path: '%$path%' },
        mutable: true
      },
//      {$: 'studio.property-toolbar-feature', path: '%$path%' }
    ]
  }
})

jb.component('studio.jb-floating-input-rich', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'group',
    controls: {$: 'studio.property-field', path: '%$path%'},
    features :{$: 'css', css: '{padding: 20px}' }
  }
})

jb.component('studio.jb-floating-input', {
  type: 'control', 
  params: [{ id: 'path', as: 'string' }], 
  impl :{$: 'group', 
    controls: [
      {$: 'editable-text', 
        title :{$: 'studio.prop-name', path: '%$path%' }, 
        databind :{$: 'studio.profile-value-as-text', path: '%$path%' }, 
        updateOnBlur: true, 
        style :{$: 'custom-style', 
          template: (cmp,state,h) => h('div',{class:'mdl-textfield mdl-js-textfield mdl-textfield--floating-label'},[
        h('input', { class: 'mdl-textfield__input', id: 'jb_input_' + state.fieldId, type: 'text',
            value: state.model,
            onchange: e => cmp.jbModel(e.target.value),
        }),
        h('label',{class: 'mdl-textfield__label', for: 'jb_input_' + state.fieldId},state.title)
      ]), 
          css: '{ margin-right: 13px; }', 
          features: [
            {$: 'field.databind-text', debounceTime: 300, oneWay: true }, 
            {$: 'mdl-style.init-dynamic' }
          ]
        }, 
        features: [
          {$: 'var', 
            name: 'suggestionData', 
            value :{$: 'object', selected: '', options: [], path: '%$path%' }, 
            mutable: true
          }, 
          {$: 'editable-text.helper-popup', 
            features :{$: 'dialog-feature.near-launcher-position' }, 
            control :{$: 'studio.suggestions-itemlist', path: '%$path%' }, 
            popupId: 'suggestions', 
            popupStyle :{$: 'dialog.popup' }, 
            showHelper :{$: 'studio.show-suggestions' }, 
            onEnter: [
              {$: 'dialog.close-dialog', id: 'studio-jb-editor-popup' }, 
              {$: 'tree.regain-focus' }
            ], 
            onEsc: [
              {$: 'dialog.close-dialog', id: 'studio-jb-editor-popup' }, 
              {$: 'tree.regain-focus' }
            ]
          }
        ]
      }, 
      {$: 'label', 
        title :{ $pipeline: [{$: 'studio.param-def', path: '%$path%' }, '%description%'] }
      }
    ], 
    features: [
      {$: 'css.padding', left: '4', right: '4' }, 
      {$: 'css.margin', $disabled: true, top: '-20', selector: '>*:last-child' }
    ]
  }
})

jb.component('studio.paste-suggestion', {
  type: 'control',
  params: [
    { id: 'option', as: 'single', defaultValue: '%%' },
    { id: 'close', as: 'boolean', description: 'ends with % or /' }
  ],
  impl: (ctx,option,close) =>
    option.paste(ctx,close)
})


function rev(str) {
  return str.split('').reverse().join('');
}

st.suggestions = class {
  constructor(input,expressionOnly) {
    this.input = input;
    this.expressionOnly = expressionOnly;
    this.pos = input.selectionStart;
    this.text = input.value.substr(0,this.pos).trim();
    this.text_with_open_close = this.text.replace(/%([^%;{}\s><"']*)%/g, (match,contents) =>
      '{' + contents + '}');
    this.exp = rev((rev(this.text_with_open_close).match(/([^\}%]*%)/) || ['',''])[1]);
    this.exp = this.exp || rev((rev(this.text_with_open_close).match(/([^\}=]*=)/) || ['',''])[1]);
    this.tail = rev((rev(this.exp).match(/([^%.\/=]*)(\/|\.|%|=)/)||['',''])[1]);
    this.tailSymbol = this.text_with_open_close.slice(-1-this.tail.length).slice(0,1); // % or /
    if (this.tailSymbol == '%' && this.exp.slice(0,2) == '%$')
      this.tailSymbol = '%$';
    this.base = this.exp.slice(0,-1-this.tail.length) + '%';
    this.inputVal = input.value;
    this.inputPos = input.selectionStart;
  }

  suggestionsRelevant() {
    return (this.inputVal.indexOf('=') == 0 && !this.expressionOnly)
      || ['%','%$','/','.'].indexOf(this.tailSymbol) != -1
  }

  extendWithOptions(probeCtx,path) {
    var options = [];
    probeCtx = probeCtx || new st.previewjb.jbCtx();
    var vars = jb.entries(Object.assign({},(probeCtx.componentContext||{}).params,probeCtx.vars,st.previewjb.resources))
        .map(x=>new ValueOption('$'+x[0],jb.val(x[1]),this.pos,this.tail))
        .filter(x=> x.toPaste.indexOf('$$') != 0)
        .filter(x=> x.toPaste.indexOf(':') == -1)
        .filter(x=>['$window'].indexOf(x.toPaste) == -1)

    if (this.inputVal.indexOf('=') == 0 && !this.expressionOnly)
      options = st.PTsOfPath(path).map(compName=> {
            var name = compName.substring(compName.indexOf('.')+1);
            var ns = compName.substring(0,compName.indexOf('.'));
            return new CompOption(compName, compName, ns ? `${name} (${ns})` : name, st.getComp(compName).description || '')
        })
    else if (this.tailSymbol == '%')
      options = [].concat.apply([],jb.toarray(probeCtx.exp('%%'))
        .map(x=>
          jb.entries(x).map(x=> new ValueOption(x[0],x[1],this.pos,this.tail))))
        .concat(vars)
    else if (this.tailSymbol == '%$')
      options = vars
    else if (this.tailSymbol == '/' || this.tailSymbol == '.')
      options = [].concat.apply([],
        jb.toarray(probeCtx.exp(this.base))
          .map(x=>jb.entries(x).map(x=>new ValueOption(x[0],x[1],this.pos,this.tail))) )

    options = jb.unique(options,x=>x.toPaste)
        .filter(x=> x.toPaste.indexOf('$jb_') != 0)
        .filter(x=> x.toPaste != this.tail)
        .filter(x=>
          this.tail == '' || typeof x.toPaste != 'string' || (x.description + x.toPaste).toLowerCase().indexOf(this.tail.toLowerCase()) != -1)
    if (this.tail)
      options.sort((x,y)=> (y.toPaste.toLowerCase().indexOf(this.tail.toLowerCase()) == 0 ? 1 : 0) - (x.toPaste.toLowerCase().indexOf(this.tail.toLowerCase()) == 0 ? 1 : 0));

    this.options = options;
    this.key = options.map(o=>o.toPaste).join(','); // build hash for the options to detect options change
    return this;
  }
}

class ValueOption {
    constructor(toPaste,value,pos,tail) {
      this.toPaste = toPaste;
      this.value = value;
      this.pos = pos;
      this.tail = tail;
      this.text = toPaste + this.valAsText();
    }
    valAsText() {
      var val = this.value;
      if (typeof val == 'string' && val.length > 20)
        return ` (${val.substring(0,20)}...)`;
      else if (typeof val == 'string' || typeof val == 'number' || typeof val == 'boolean')
        return ` (${val})`;
      else if (Array.isArray(val))
        return ` (${val.length} items)`
      return ``;
    }
    paste(ctx,_close) {
      //var close = typeof this.value != 'object' || Array.isArray(this.value) || _close;

      var toPaste = this.toPaste + (_close ? '%' : '/');
      var input = ctx.vars.selectionKeySource.input;
      var pos = this.pos + 1;
      input.value = input.value.substr(0,this.pos-this.tail.length) + toPaste + input.value.substr(pos);
      this.writeValue(ctx);
//      suggestionCtx.selected = null;
      return jb.delay(1,ctx).then (() => {
        input.selectionStart = pos + toPaste.length;
        input.selectionEnd = input.selectionStart;
      })
    }
    writeValue(ctx) {
      var input = ctx.vars.selectionKeySource.input;
      var path = ctx.exp('%$suggestionData/path%','string');
      st.writeValueOfPath(path,input.value);
    }
}

class CompOption {
    constructor(toPaste,value,text,description) {
       this.toPaste = toPaste;
       this.value = value;
       this.text = text;
       this.description = description;
    }
    paste(ctx) {
      var input = ctx.vars.selectionKeySource.input;
      input.value = '=' + this.toPaste;
      this.writeValue(ctx);
      // dirty design ?
        // var closeAndWriteValue = _ => {
        //   params.closeFloatingInput();
        //   var option = input.value.indexOf('=') == 0 ? new CompOption(input.value.substr(1)) : new ValueOption();
        //   option.writeValue(cmp.ctx);
        // };
    }
    writeValue(ctx) {
      st.setComp(ctx.exp('%$suggestionData/path%','string'),this.toPaste);
      ctx.run({$: 'dialog.close-dialog', id: 'studio-jb-editor-popup' });
      ctx.run({$:'studio.expand-and-select-first-child-in-jb-editor' });
    }
}


})()
;

(function() {
var st = jb.studio;

st.compsHistory = [];
st.undoIndex = 0;

function setToVersion(versionIndex,ctx,after) {
		var version = st.compsHistory[versionIndex];
		if (!version || !version.opEvent) debugger;

    opEvent = Object.assign({},version.opEvent);
    opEvent.oldVal = version.opEvent.newVal;
    opEvent.newVal = version.opEvent.oldVal;
    opEvent.srcCtx = ctx;

    if (after) {
      st.previewjb.comps = version.after;
	    st.compsRefHandler.resourceVersions = version.opEvent.resourceVersionsAfter;
    } else {
      st.previewjb.comps = version.before;
	    st.compsRefHandler.resourceVersions = version.opEvent.resourceVersionsBefore;
    }

    st.compsRefHandler.resourceChange.next(opEvent);
}

jb.component('studio.undo', {
	type: 'action',
	impl: ctx => {
		if (st.undoIndex > 0)
			setToVersion(--st.undoIndex,ctx)
	}
})

jb.component('studio.clean-selection-preview', {
	type: 'action',
	impl: (ctx) => {
		if (st.compsHistory.length > 0)
			st.previewjb.comps = st.compsHistory.slice(-1)[0].after;
	}
})

jb.component('studio.revert', {
	type: 'action',
	params: [
		{ id: 'toIndex', as: 'number' }
	],
	impl: (ctx,toIndex) => {
		if (st.compsHistory.length == 0 || toIndex < 0) return;
		st.undoIndex = toIndex;
		st.compsHistory = st.compsHistory.slice(0,toIndex+1);
		setToVersion(st.undoIndex,ctx)
	}
})

jb.component('studio.redo', {
	type: 'action',
	impl: ctx => {
		if (st.undoIndex < st.compsHistory.length)
			setToVersion(st.undoIndex++,ctx,true)
	}
})

jb.component('studio.copy', {
	type: 'action',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		st.clipboard = st.valOfPath(path)
})

jb.component('studio.paste', {
	type: 'action',
	params: [ {id: 'path', as: 'string' } ],
	impl: (ctx,path) =>
		(st.clipboard != null) && jb.writeValue(st.refOfPath(path),st.clipboard,ctx)
})

jb.component('studio.script-history-items', {
	impl: ctx => st.compsHistory
})

jb.component('studio.comps-undo-index', {
	impl: ctx => st.undoIndex-1
})

jb.component('studio.open-script-history', {
  type: 'action',
  impl :{$: 'open-dialog',
      content :{$: 'studio.script-history' },
      style :{$: 'dialog.studio-floating',
        id: 'script-history',
        width: '700',
        height: '400'
      },
      title: 'Script History'
  }
})

jb.component('studio.script-history', {
  type: 'control',
  impl :{$: 'group',
    controls: [
      {$: 'table',
        items :{$: 'studio.script-history-items' },
        fields: [
          {$: 'field.control',
            title: 'changed',
            control :{$: 'button',
              title :{$: 'studio.name-of-ref', ref: '%opEvent/ref%' },
              action :{$: 'studio.goto-path',
                path :{$: 'studio.path-of-ref', ref: '%opEvent/ref%' }
              },
              style :{$: 'button.href' },
              features :{$: 'feature.hover-title',
                title :{$: 'studio.path-of-ref', ref: '%opEvent/ref%' }
              }
            },
            width: '100'
          },
          {$: 'field',
            title: 'from',
            data :{$: 'pretty-print', profile: '%opEvent/oldVal%' },
            width: '200'
          },
          {$: 'field',
            title: 'to',
            data :{$: 'pretty-print', profile: '%opEvent/newVal%' },
            width: '200'
          },
          {$: 'field.control',
            title: 'undo/redo',
            control :{$: 'button',
              title: 'revert to here',
              action :{$: 'studio.revert', toIndex: '%undoIndex%' },
              style :{$: 'button.href' }
            },
            width: '100'
          }
        ],
        style :{$: 'table.with-headers' }
      }
    ],
    features: [
      {$: 'watch-observable',
        toWatch: ctx => st.compsRefHandler.resourceChange.debounceTime(500),
      },
      {$: 'css.height', height: '400', overflow: 'auto', minMax: 'max' }
    ]
  }
})


})()
;

(function() {
  var st = jb.studio;

jb.component('studio.edit-source', {
  type: 'action', 
  params: [
    {
      id: 'path', 
      as: 'string', 
      defaultValue :{$: 'studio.currentProfilePath' }
    }
  ], 
  impl :{$: 'open-dialog', 
    style :{$: 'dialog.studio-floating', id: 'edit-source', width: 600 }, 
    content :{$: 'editable-text', 
      databind :{$: 'studio.profile-as-text', path: '%$path%' }, 
      style :{$: 'editable-text.codemirror', mode: 'javascript' }
    }, 
    title :{$: 'studio.short-title', path: '%$path%' }, 
    features: [
      {$: 'css', css: '.jb-dialog-content-parent {overflow-y: hidden}' }, 
      {$: 'dialog-feature.resizer', "resize-inner-codemirror": 'true', resizeInnerCodemirror: true }
    ]
  }
})

jb.component('studio.goto-editor-options', {
	type: 'menu.option',
	params: [
		{ id: 'path', as: 'string'},
	],
    impl :{$: 'menu.end-with-separator',
      options :[
        {$: 'studio.goto-editor-first', path: '%$path%'},
        {$: 'studio.goto-editor-secondary', path: '%$path%'},
      ]
    }
})

jb.component('studio.goto-editor-first', {
  type: 'action',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'menu.action',
    title :{
      $pipeline: [{$: 'studio.comp-name', path: '%$path%' }, 'Goto editor: %%']
    },
    action :{$: 'studio.open-editor',
      path :{$: 'studio.comp-name', path: '%$path%' }
    },
    shortcut: 'Alt+E',
    showCondition :{$: 'notEmpty',
      item :{$: 'studio.comp-name', path: '%$path%' }
    }
  }
})

jb.component('studio.goto-editor-secondary', {
  type: 'action',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'menu.action',
    $vars: { baseComp: {$: 'split', text: '%$path%', separator: '~', part: 'first' }},
    title :  'Goto editor: %$baseComp%',
    action :{$: 'studio.open-editor', path: '%$baseComp%' },
    showCondition :{$: 'not-equals',
      item1 :{$: 'studio.comp-name', path: '%$path%' },
      item2 : '%$baseComp%'
    }
  }
})

jb.component('studio.open-editor', {
	type: 'action',
	params: [
		{ id: 'path', as: 'string'},
	],
	impl: (ctx,path) => {
		path && fetch(`/?op=gotoSource&comp=${path.split('~')[0]}`)
	}
})

})()
;


jb.component('studio.open-jb-editor', {
  type: 'action',
  params: [
    { id: 'path', as: 'string' },
    { id: 'fromPath', as: 'string' },
    { id: 'newWindow', type: 'boolean', as: 'boolean' }
  ],
  impl :{$: 'open-dialog',
    $vars: {
      dialogId :{ $if: '%$newWindow%', then: '', else: 'jb-editor' },
      fromPath: '%$fromPath%',
      pickSelection :{$: 'object' }
    },
    style :{$: 'dialog.studio-floating',
      id: '%$dialogId%',
      width: '860',
      height: '400'
    },
    content :{$: 'studio.jb-editor', path: '%$path%' },
    menu :{$: 'button',
      action :{$: 'studio.open-jb-editor-menu',
        path: '%$jbEditor_selection%',
        root: '%$path%'
      },
      style :{$: 'button.mdl-icon', icon: 'menu' }
    },
    title :{$: 'studio.path-hyperlink', path: '%$path%', prefix: 'Inteliscript' },
    features: [
      {$: 'var', name: 'jbEditor_selection', value: '%$path%', mutable: true },
      {$: 'dialog-feature.resizer' }
    ]
  }
})

jb.component('studio.open-component-in-jb-editor', {
  type: 'action',
  params: [{ id: 'path', as: 'string' }, { id: 'fromPath', as: 'string' }],
  impl :{
    $vars: {
      compPath :{$: 'split', separator: '~', text: '%$path%', part: 'first' },
      fromPath: '%$fromPath%',
      pickSelection :{$: 'object' }
    },
    $runActions: [
      {$: 'open-dialog',
        style :{$: 'dialog.studio-floating',
          id: 'jb-editor',
          width: '860',
          height: '400'
        },
        content :{$: 'studio.jb-editor', path: '%$compPath%' },
        menu :{$: 'button',
          action :{$: 'studio.open-jb-editor-menu',
            path: '%$jbEditor_selection%',
            root: '%$path%'
          },
          style :{$: 'button.mdl-icon', icon: 'menu' }
        },
        title :{$: 'studio.path-hyperlink',
          path: '%$compPath%',
          prefix: 'Inteliscript'
        },
        features: [
          {$: 'var',
            name: 'jbEditor_selection',
            value: '%$path%',
            mutable: true
          },
          {$: 'dialog-feature.resizer' }
        ]
      }
    ]
  }
})

jb.component('studio.jb-editor', {
  type: 'control',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'group',
    title: 'main',
    style :{$: 'layout.horizontal-fixed-split', align: 'space-between', direction: '', leftWidth: '350', rightWidth: '500', spacing: 3 },
    controls: [
      {$: 'tree',
        nodeModel :{$: 'studio.jb-editor.nodes', path: '%$path%' },
        features: [
          {$: 'css.class', class: 'jb-editor jb-control-tree' },
          {$: 'tree.selection',
            onDoubleClick :{$: 'studio.open-jb-edit-property', path: '%$jbEditor_selection%' },
            databind: '%$jbEditor_selection%',
            autoSelectFirst: true
          },
          {$: 'tree.keyboard-selection',
            onEnter :{$: 'studio.open-jb-edit-property', path: '%$jbEditor_selection%' },
            onRightClickOfExpanded :{$: 'studio.open-jb-editor-menu', path: '%%', root: '%$path%' },
            autoFocus: true,
            applyMenuShortcuts :{$: 'studio.jb-editor-menu', path: '%%', root: '%$path%' }
          },
          {$: 'tree.drag-and-drop' },
          {$: 'css.width', width: '500', selector: 'jb-editor' },
          {$: 'studio.watch-script-changes' }
        ]
      },
      {$: 'group',
        title: 'watch selection',
        controls: [
          {$: 'group',
            title: 'hide if selection empty',
            controls: [
              {$: 'group',
                title: 'watch selection content',
                controls :{$: 'group',
                  title: 'wait for probe',
                  controls: [
                    {$: 'label',
                      title: '{? closest Path: %$probeResult/closestPath% ?}',
                      features :{$: 'css', css: '{ color: red}' }
                    },
                    {$: 'label', title: 'circuit %$probeResult/circuit.$%, time: %$probeResult/totalTime% mSec' },
                    {$: 'table',
                      items :{
                        $pipeline: [
                          '%$probeResult/result%',
                          {$: 'slice', end: '%$maxInputs%' }
                        ]
                      },
                      fields: [
                        {$: 'field.control',
                          title: 'in (%$probeResult/result/length%)',
                          control :{$: 'studio.data-browse', obj: '%in/data%' },
                          width: '100'
                        },
                        {$: 'field.control',
                          title: 'out',
                          control :{$: 'studio.data-browse', obj: '%out%' },
                          width: '100'
                        }
                      ],
                      style :{$: 'table.mdl', classForTable: 'mdl-data-table', classForTd: 'mdl-data-table__cell--non-numeric' },
                      features: [
                        {$: 'css', css: '{white-space: normal}' },
                        {$: 'watch-ref', ref: '%$maxInputs%' }
                      ]
                    },
                    {$: 'button',
                      title: 'show (%$probeResult/result/length%)',
                      action :{$: 'write-value',
                        style :{$: 'dialog.popup' },
                        content :{$: 'table',
                          items: '%$obj%',
                          fields :{$: 'field.control',
                            title :{ $pipeline: [{$: 'count', items: '%$obj%' }, '%% items'] },
                            control :{$: 'studio.data-browse', a: 'label', obj: '%%', width: 200 }
                          },
                          style :{$: 'table.mdl',
                            classForTable: 'mdl-data-table mdl-js-data-table mdl-data-table--selectable mdl-shadow--2dp',
                            classForTd: 'mdl-data-table__cell--non-numeric'
                          }
                        },
                        to: '%$maxInputs%',
                        value: '100'
                      },
                      style :{$: 'button.href' },
                      features: [
                        {$: 'watch-ref', ref: '%$maxInputs%' },
                        {$: 'hidden',
                          showCondition :{ $and: ['%$maxInputs% == 5', '%$probeResult/result/length% > 5'] }
                        }
                      ]
                    }
                  ],
                  features: [
                    {$: 'group.wait',
                      for :{$: 'studio.probe', path: '%$jbEditor_selection%' },
                      loadingControl :{$: 'label', title1: 'calculating...', title: '...' },
                      varName: 'probeResult'
                    },
                    {$: 'var', name: 'maxInputs', value: '5', mutable: true }
                  ]
                },
                features :{$: 'watch-ref',
                  ref :{$: 'studio.ref', path: '%$jbEditor_selection%' }
                }
              }
            ],
            features :{$: 'feature.if', showCondition: '%$jbEditor_selection%' }
          }
        ],
        features: [
          {$: 'watch-ref', ref: '%$jbEditor_selection%' },
          {$: 'studio.watch-script-changes' }
        ]
      }
    ],
    features: [
      {$: 'css.padding', top: '10' },
      {$: 'css.height', height: '800', minMax: 'max' }
    ]
  }
})

jb.component('studio.data-browse', {
  type: 'control',
  params: [{ id: 'obj', essential: true, defaultValue: '%%' }, { id: 'title', as: 'string' }, { id: 'width', as: 'number', defaultValue: 200 }],
  impl :{$: 'group',
    title: '%$title%',
    controls :{$: 'group',
      controls: [
        {$: 'control.first-succeeding',
          controls: [
            {$: 'control-with-condition',
              condition :{$: 'in-group',
                obj: '%$obj%',
                group :{ $list: ['JbComponent', 'jbCtx'] },
                item :{$: 'class-name', obj: '%$obj%' }
              },
              control :{$: 'label',
                title :{$: 'class-name', obj: '%$obj%' }
              }
            },
            {$: 'control-with-condition',
              condition :{$: 'is-of-type', type: 'string,boolean,number', obj: '%$obj%' },
              control :{$: 'label', title: '%$obj%' }
            },
            {$: 'control-with-condition',
              condition :{$: 'is-of-type', type: 'array', obj: '%$obj%' },
              control :{$: 'table',
                items :{
                  $pipeline: [
                    '%$obj%',
                    {$: 'slice', end: '%$maxItems%' }
                  ]
                },
                fields :{$: 'field.control',
                  title :{ $pipeline: [{$: 'count', items: '%$obj%' }, '%% items'] },
                  control :{$: 'studio.data-browse', a: 'label', obj: '%%', width: 200 }
                },
                style :{$: 'table.mdl',
                  classForTable: 'mdl-data-table mdl-js-data-table mdl-data-table--selectable mdl-shadow--2dp',
                  classForTd: 'mdl-data-table__cell--non-numeric'
                },
                features: [{$: 'watch-ref', ref: '%$maxItems%' }]
              }
            },
            {$: 'control-with-condition',
              condition :{$: 'isNull', obj: '%$obj%' },
              control :{$: 'label', title: 'null' }
            },
            {$: 'tree',
              nodeModel :{$: 'tree.json-read-only', object: '%$obj%', rootPath: '%$title%' },
              style :{$: 'tree.no-head' },
              features: [
                {$: 'css.class', class: 'jb-control-tree' },
                {$: 'tree.selection' },
                {$: 'tree.keyboard-selection' },
                {$: 'css.width', width: '%$width%', minMax: 'max' }
              ]
            }
          ]
        },
        {$: 'control-with-condition',
          style :{$: 'button.href' },
          condition :{
            $and: [
              '%$obj/length% > 100',
              {$: 'is-of-type', type: 'string', obj: '%$obj%' }
            ]
          },
          control :{$: 'button',
            title: 'open (%$obj/length%)',
            action :{$: 'open-dialog',
              style :{$: 'dialog.popup' },
              content :{$: 'editable-text',
                title: '',
                databind: '%$obj%',
                style :{$: 'editable-text.codemirror',
                  enableFullScreen: true,
                  height: '200',
                  mode: 'text',
                  debounceTime: 300,
                  lineNumbers: true,
                  readOnly: true
                }
              }
            },
            style :{$: 'button.href' }
          },
          title: 'long text'
        },
        {$: 'control-with-condition',
          style :{$: 'button.href' },
          condition :{
            $and: [
              '%$obj/length% > 5',
              {$: 'is-of-type', type: 'array', obj: '%$obj%' },
              '%$maxItems% == 5'
            ]
          },
          control :{$: 'button',
            title: 'show (%$obj/length%)',
            action :{$: 'write-value',
              style :{$: 'dialog.popup' },
              content :{$: 'table',
                items: '%$obj%',
                fields :{$: 'field.control',
                  title :{ $pipeline: [{$: 'count', items: '%$obj%' }, '%% items'] },
                  control :{$: 'studio.data-browse', a: 'label', obj: '%%', width: 200 }
                },
                style :{$: 'table.mdl',
                  classForTable: 'mdl-data-table mdl-js-data-table mdl-data-table--selectable mdl-shadow--2dp',
                  classForTd: 'mdl-data-table__cell--non-numeric'
                }
              },
              to: '%$maxItems%',
              value: '100'
            },
            style :{$: 'button.href' },
            features: [
              {$: 'watch-ref', ref: '%$maxItems%' },
              {$: 'hidden', showCondition: '%$maxItems% == 5' }
            ]
          },
          title: 'large array'
        }
      ],
      features: [{$: 'var', name: 'maxItems', value: '5', mutable: 'true' }]
    }
  }
})

jb.component('studio.open-jb-edit-property', {
  type: 'action',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'action.switch',
    $vars: {
      actualPath :{$: 'studio.jb-editor-path-for-edit', path: '%$path%' },
      paramDef :{$: 'studio.param-def', path: '%$actualPath%' }
    },
    cases: [
      {$: 'action.switch-case',
        condition :{$: 'ends-with',
          type: 'array',
          obj :{$: 'studio.val', path: '%$actualPath%' },
          endsWith: '$vars',
          text: '%$path%'
        }
      },
      {$: 'action.switch-case',
        condition: '%$paramDef/options%',
        action :{$: 'open-dialog',
          style :{$: 'dialog.studio-jb-editor-popup' },
          content :{$: 'group',
            controls: [{$: 'studio.jb-floating-input-rich', path: '%$actualPath%' }],
            features: [
              {$: 'feature.onEsc',
                action :{$: 'dialog.close-containing-popup', OK: true }
              },
              {$: 'feature.onEnter',
                action: [
                  {$: 'dialog.close-containing-popup', OK: true },
                  {$: 'tree.regain-focus' }
                ]
              }
            ]
          },
          features: [
            {$: 'dialog-feature.auto-focus-on-first-input' },
            {$: 'dialog-feature.onClose',
              action :{$: 'tree.regain-focus' }
            }
          ]
        }
      },
      {$: 'action.switch-case',
        condition :{$: 'is-of-type',
          type: 'function',
          obj :{$: 'studio.val', path: '%$actualPath%' }
        },
        action :{$: 'studio.edit-source', path: '%$actualPath%' }
      },
      {$: 'action.switch-case',
        condition :{$: 'studio.is-of-type', path: '%$actualPath%', type: 'data,boolean' },
        action :{$: 'open-dialog',
          style :{$: 'dialog.studio-jb-editor-popup' },
          content :{$: 'studio.jb-floating-input', path: '%$actualPath%' },
          features: [
            {$: 'dialog-feature.auto-focus-on-first-input' },
            {$: 'dialog-feature.onClose',
              action :{
                $runActions: [
                  {$: 'toggle-boolean-value',
                    of: '%$studio/jb_preview_result_counter%'
                  },
                  {$: 'tree.regain-focus' }
                ]
              }
            }
          ]
        }
      },
      {$: 'action.switch-case',
        $vars: {
          ptsOfType :{$: 'studio.PTs-of-type',
            type :{$: 'studio.param-type', path: '%$actualPath%' }
          }
        },
        condition: '%$ptsOfType/length% == 1',
        action :{$: 'studio.set-comp', path: '%$path%', comp: '%$ptsOfType[0]%' }
      }
    ],
    defaultAction :{$: 'studio.open-new-profile-dialog',
      path: '%$actualPath%',
      type :{$: 'studio.param-type', path: '%$actualPath%' },
      mode: 'update',
      onClose :{$: 'tree.regain-focus' }
    }
  }
})

jb.component('studio.jb-editor-path-for-edit', {
  type: 'data',
  description: 'in case of array, use extra element path',
  params: [ { id: 'path', as: 'string' } ],
  impl: (ctx,path) => {
    var ar = jb.studio.valOfPath(path);
    if (Array.isArray(ar))
      return path + '~' + ar.length;
    return path;
  }
})


jb.component('studio.open-jb-editor-menu', {
  type: 'action',
  params: [
    { id: 'path', as: 'string' },
    { id: 'root', as: 'string' },
  ],
  impl :{$: 'menu.open-context-menu',
    menu :{$: 'studio.jb-editor-menu', path: '%$path%', root: '%$root%' } ,
    features :{$: 'dialog-feature.onClose',
      action :{$: 'tree.regain-focus'}
    },
  }
})

jb.component('studio.jb-editor-menu', {
  type: 'menu.option',
  params: [{ id: 'path', as: 'string' }, { id: 'root', as: 'string' }],
  impl :{$: 'menu.menu',
    style :{$: 'menu.context-menu' },
    features :{$: 'group.menu-keyboard-selection', autoFocus: true },
    options: [
      {$: 'menu.action',
        title: 'Add property',
        action :{$: 'open-dialog',
          id: 'add property',
          style :{$: 'dialog.popup', okLabel: 'OK', cancelLabel: 'Cancel' },
          content :{$: 'group',
            controls: [
              {$: 'editable-text',
                title: 'property name',
                databind: '%$name%',
                style :{$: 'editable-text.mdl-input' },
                features: [
                  {$: 'feature.onEnter',
                    action: [
                      {$: 'write-value',
                        to :{$: 'studio.ref', path: '%$path%~%$name%' },
                        value: ''
                      },
                      {$: 'dialog.close-containing-popup', OK: true },
                      {$: 'tree.redraw' },
                      {$: 'tree.regain-focus' }
                    ]
                  }
                ]
              }
            ],
            features :{$: 'css.padding', top: '9', left: '20', right: '20' }
          },
          title: 'Add Property',
          modal: 'true',
          features: [
            {$: 'var', name: 'name', mutable: true },
            {$: 'dialog-feature.near-launcher-position' },
            {$: 'dialog-feature.auto-focus-on-first-input' }
          ]
        },
        showCondition :{$: 'equals',
          item1 :{$: 'studio.comp-name', path: '%$path%' },
          item2: 'object'
        }
      },
      {$: 'menu.action',
        title: 'Add variable',
        action :{$: 'studio.add-variable', path: '%$path%' },
        showCondition :{$: 'ends-with', endsWith: '~$vars', text: '%$path%' }
      },
      {$: 'menu.end-with-separator',
        options :{$: 'menu.dynamic-options',
          endsWithSeparator: true,
          items :{$: 'studio.more-params', path: '%$path%' },
          genericOption :{$: 'menu.action',
            title :{$: 'suffix', separator: '~' },
            action :{$: 'runActions',
              actions: [
                {$: 'studio.add-property', path: '%%' },
                {$: 'tree.redraw' },
                {$: 'dialog.close-containing-popup' },
                {$: 'write-value', to: '%$jbEditor_selection%', value: '%%' },
                {$: 'studio.open-jb-edit-property', path: '%%' }
              ]
            }
          }
        }
      },
      {$: 'menu.action',
        title: 'Variables',
        action: [
          {$: 'write-value',
            to :{$: 'studio.ref', path: '%$path%~$vars' },
            value :{$: 'object' }
          },
          {$: 'write-value', to: '%$jbEditor_selection%', value: '%$path%~$vars' },
          {$: 'tree.redraw' },
          {$: 'studio.add-variable', path: '%$path%~$vars' }
        ],
        showCondition :{
          $and: [
            {
              $isEmpty :{$: 'studio.val', path: '%$path%~$vars' }
            },
            {$: 'is-of-type',
              type: 'object',
              obj :{$: 'studio.val', path: '%$path%' }
            }
          ]
        }
      },
      {$: 'studio.style-editor-options', path: '%$path%' },
      {$: 'menu.end-with-separator',
        options: [
          {$: 'menu.action',
            $vars: {
              compName :{$: 'split', separator: '~', text: '%$root%', part: 'first' }
            },
            title: 'Goto parent',
            action :{$: 'studio.open-component-in-jb-editor', path: '%$path%', fromPath: '%$fromPath%' },
            showCondition :{$: 'contains', text: '~', allText: '%$root%' }
          },
          {$: 'menu.action',
            $vars: {
              compName :{$: 'studio.comp-name', path: '%$path%' }
            },
            title: 'Goto %$compName%',
            action :{$: 'studio.open-jb-editor', path: '%$compName%', fromPath: '%$path%' },
            showCondition: '%$compName%'
          },
          {$: 'menu.action',
            $vars: {
              compName :{$: 'split', separator: '~', text: '%$fromPath%', part: 'first' }
            },
            title: 'Back to %$compName%',
            action :{$: 'studio.open-component-in-jb-editor', path: '%$fromPath%', fromPath: '%$path%' },
            showCondition: '%$fromPath%'
          }
        ]
      },
      {$: 'studio.goto-editor-options', path: '%$path%' },
      {$: 'menu.studio-wrap-with',
        path: '%$path%',
        type: 'control',
        components :{$: 'list', items: ['group'] }
      },
      {$: 'menu.studio-wrap-with',
        path: '%$path%',
        type: 'data',
        components :{$: 'list', items: ['pipeline', 'list', 'firstSucceeding'] }
      },
      {$: 'menu.studio-wrap-with',
        path: '%$path%',
        type: 'boolean',
        components :{$: 'list', items: ['and', 'or', 'not'] }
      },
      {$: 'menu.studio-wrap-with',
        path: '%$path%',
        type: 'action',
        components :{$: 'list', items: ['runActions', 'runActionOnItems'] }
      },
      {$: 'menu.studio-wrap-with-array', path: '%$path%' },
      {$: 'menu.action',
        title: 'Duplicate',
        action :{$: 'studio.duplicate-array-item', path: '%$path%' },
        showCondition :{$: 'studio.is-array-item', path: '%$path%' },
        shortcut: 'Ctrl+D',
      },
      {$: 'menu.separator' },
      {$: 'menu.action',
        title: 'Pick context',
        action :{$: 'studio.pick' }
      },
      {$: 'studio.goto-references-menu',
        path :{$: 'split', separator: '~', text: '%$path%', part: 'first' }
      },
      {$: 'menu.action',
        title: 'Remark',
        action :{$: 'open-dialog',
          id: 'add property',
          style :{$: 'dialog.popup' },
          content :{$: 'group',
            controls: [
              {$: 'editable-text',
                title: 'remark',
                databind : '%$remark%',
                style :{$: 'editable-text.mdl-input' },
                features: [
                  {$: 'feature.onEnter',
                    action: [
                      {$: 'write-value', value: '%$remark%', to: {$: 'studio.ref', path: '%$path%~remark' }},
                      {$: 'dialog.close-containing-popup', OK: true },
                      {$: 'tree.redraw' },
                      {$: 'tree.regain-focus' }
                    ]
                  }
                ]
              }
            ],
            features :{$: 'css.padding', top: '9', left: '20', right: '20' }
          },
          title: 'Remark',
          modal: 'true',
          features: [
            {$: 'var', name: 'remark', value: {$: 'studio.val', path: '%$path%~remark' }, mutable: true },
            {$: 'dialog-feature.near-launcher-position' },
            {$: 'dialog-feature.auto-focus-on-first-input' }
          ]
        },
        showCondition :{$: 'is-of-type',
          type: 'object',
          obj :{$: 'studio.val', path: '%$path%' }
        }
      },
      {$: 'menu.action',
        title: 'Javascript',
        action :{$: 'studio.edit-source', path: '%$path%' },
        icon: 'code',
        shortcut: 'Ctrl+J'
      },
      {$: 'menu.action',
        title: 'Delete',
        action :{$: 'studio.delete', path: '%$path%' },
        icon: 'delete',
        shortcut: 'Delete'
      },
      {$: 'menu.action',
        title :{
          $if :{$: 'studio.disabled', path: '%$path%' },
          then: 'Enable',
          else: 'Disable'
        },
        action :{$: 'studio.toggle-disabled', path: '%$path%' },
        icon: 'do_not_disturb',
        shortcut: 'Ctrl+X'
      },
      {$: 'menu.action',
        title: 'Copy',
        action :{$: 'studio.copy', path: '%$path%' },
        icon: 'copy',
        shortcut: 'Ctrl+C'
      },
      {$: 'menu.action',
        title: 'Paste',
        action :{$: 'studio.paste', path: '%$path%' },
        icon: 'paste',
        shortcut: 'Ctrl+V'
      },
      {$: 'menu.action',
        title: 'Undo',
        action :{$: 'studio.undo' },
        icon: 'undo',
        shortcut: 'Ctrl+Z'
      },
      {$: 'menu.action',
        title: 'Redo',
        action :{$: 'studio.redo' },
        icon: 'redo',
        shortcut: 'Ctrl+Y'
      }
    ]
  }
})

jb.component('menu.studio-wrap-with', {
  type: 'menu.option',
  params: [
    { id: 'path', as: 'string'},
    { id: 'type', as: 'string' },
    { id: 'components', as: 'array' },
  ],
  impl :{$: 'menu.dynamic-options',
    items : {
          $if: {$: 'studio.is-of-type', path: '%$path%', type: '%$type%' },
          then: '%$components%',
          else: {$list: [] }
    },
        genericOption :{$: 'menu.action',
          title: 'Wrap with %%',
          action : [
            {$: 'studio.wrap', path: '%$path%', comp: '%%' },
            {$:'studio.expand-and-select-first-child-in-jb-editor' }
          ]
    },
  }
})

jb.component('menu.studio-wrap-with-array', {
  type: 'menu.option',
  params: [
    { id: 'path', as: 'string'},
  ],
  impl :{ $if: {$: 'studio.can-wrap-with-array', path: '%$path%' },
        then :{$: 'menu.action',
          title: 'Wrap with array',
          action : [
            {$: 'studio.wrap-with-array', path: '%$path%' },
            {$:'studio.expand-and-select-first-child-in-jb-editor' }
          ]
    }, else: []
  }
})

jb.component('studio.add-variable', {
  type: 'action',
  params: [
    { id: 'path', as: 'string'},
  ],
  impl :{$: 'on-next-timer', action:{$: 'open-dialog',
    id: 'add variable',
    style :{$: 'dialog.popup', okLabel: 'OK', cancelLabel: 'Cancel' },
    content :{$: 'group',
      controls: [
        {$: 'editable-text',
          title: 'variable name',
          databind: '%$name%',
          style :{$: 'editable-text.mdl-input' },
          features: [
            {$: 'feature.onEnter',
              action: [
                {$: 'write-value',
                  to :{$: 'studio.ref', path: '%$path%~%$name%' },
                  value: ''
                },
                {$: 'dialog.close-containing-popup', OK: true },
                {$: 'write-value', to: '%$jbEditor_selection%', value: '%$path%~%$name%' },
                {$: 'tree.redraw', strong: true },
                {$: 'tree.regain-focus' }
              ]
            }
          ]
        }
      ],
      features :{$: 'css.padding', top: '9', left: '20', right: '20' }
    },
    title: 'New variable',
    // onOK :[
    //   {$: 'write-value',
    //     to :{$: 'studio.ref', path: '%$path%~%$name%' },
    //     value: ''
    //   },
    //   {$: 'write-value', to: '%$jbEditor_selection%', value: '%$path%~%$name%' },
    //   {$:'tree.redraw' },
    //   {$: 'tree.regain-focus' },
    // ],
    modal: 'true',
    features: [
      {$: 'var', name: 'name', mutable: true },
      {$: 'dialog-feature.near-launcher-position' },
      {$: 'dialog-feature.auto-focus-on-first-input' }
    ]
  }}
})


jb.component('studio.expand-and-select-first-child-in-jb-editor', {
  type: 'action',
  impl: ctx => {
    var ctxOfTree = ctx.vars.$tree ? ctx : jb.ctxDictionary[document.querySelector('.jb-editor').getAttribute('jb-ctx')];
    var tree = ctxOfTree.vars.$tree;
    if (!tree) return;
    tree.expanded[tree.selected] = true;
    jb.delay(100).then(()=>{
      var firstChild = tree.nodeModel.children(tree.selected)[0];
      if (firstChild) {
        tree.selectionEmitter.next(firstChild);
        tree.regainFocus && tree.regainFocus();
//        jb_ui.apply(ctx);
//        jb.delay(100);
      }
    })
  }
})
;

jb.component('dialog.studio-jb-editor-popup', {
  type: 'dialog.style',
  impl: {$: 'custom-style',
      template: (cmp,state,h) => h('div',{ class: 'jb-dialog jb-popup' },[
        h('button',{class: 'dialog-close', onclick: _=> cmp.dialogClose() },'×'),
        h(state.contentComp),
      ]),
      css: `{ background: #fff; position: absolute }
        >.dialog-close {
            position: absolute; 
            cursor: pointer; 
            right: 0;
            font: 21px sans-serif; 
            border: none; 
            background: transparent; 
            color: #000; 
            text-shadow: 0 1px 0 #fff; 
            font-weight: 700; 
            opacity: .2;
        }
        >.dialog-close:hover { opacity: .5 }
        `,
      features: [
        { $: 'dialog-feature.max-zIndex-on-click' },
        { $: 'dialog-feature.close-when-clicking-outside' },
        { $: 'dialog-feature.near-launcher-position' },
        { $: 'dialog-feature.unique-dialog', id: 'studio-jb-editor-popup' },
        {$: 'css.box-shadow', 
          blurRadius: 5, 
          spreadRadius: 0, 
          shadowColor: '#000000', 
          opacity: 0.75, 
          horizontal: 0, 
          vertical: 0, 
        }
   ]
  }
})

jb.component('dialog.studio-suggestions-popup',{
  type: 'dialog.style',
  impl: {$: 'custom-style',
      template: (cmp,state,h) => h('div',{ class: 'jb-dialog jb-popup' },[
        h(state.contentComp),
      ]),
      css: `{ background: #fff; position: absolute; padding: 3px 5px }`,
      features: [
        { $: 'dialog-feature.max-zIndex-on-click' },
        { $: 'dialog-feature.close-when-clicking-outside' },
        { $: 'dialog-feature.css-class-on-launching-element' },
        { $: 'dialog-feature.near-launcher-position' },
//        { $: 'studio.fix-suggestions-margin' } ,
        { $: 'dialog-feature.unique-dialog', id: 'studio-suggestions-popup' },
        { $: 'css.box-shadow', 
          blurRadius: 5, 
          spreadRadius: 0, 
          shadowColor: '#000000', 
          opacity: 0.75, 
          horizontal: 0, 
          vertical: 0, 
        }
   ]
  }
})
;

jb.component('studio.open-style-editor', {
  type: 'action',
  params: [{ id: 'path', as: 'string' }],
  impl :{$: 'open-dialog',
    $vars: {
      styleSource :{$: 'studio.style-source', path: '%$path%' }
    },
    style :{$: 'dialog.studio-floating', id: 'style editor', width: '800' },
    content :{$: 'studio.style-editor', path: '%$path%' },
    features: {$: 'dialog-feature.resizer'},
    menu :{$: 'button',
      title: 'style menu',
      action :{$: 'studio.open-style-menu', path: '%$path%' },
      style :{$: 'button.mdl-icon', icon: 'menu' },
      features :{$: 'css', css: 'button { background: transparent }' }
    },
    title: 'Style Editor - %$styleSource/path%'
  }
})

jb.component('studio.open-style-menu', {
  type: 'action',
  params: [
    { id: 'path', as: 'string' }
  ],
  impl :{$: 'menu.open-context-menu',
    menu :{$: 'menu.menu',
      options: [
        {$: 'menu.action',
          title: 'Clone as local style',
          icon: 'build',
          action : [
            {$: 'studio.make-local', path: '%$path%' },
            {$: 'studio.open-style-editor', path: '%$styleSource/innerPath%' },
            {$: 'studio.open-properties' },
          ],
          showCondition: "%$styleSource/type% == 'global'",
        },
        {$: 'menu.action',
          title: 'Extract style as a reusable component',
          icon: 'build',
          action :{$: 'studio.open-make-global-style', path: '%$path%' },
          showCondition: "%$styleSource/type% == 'inner'",
        },
        {$: 'menu.action',
          title: 'Format css',
          action :{$: 'write-value',
            to :{$: 'studio.profile-as-text',  path: '%$styleSource/path%~css', stringOnly: true },
            value :{$: 'studio.format-css',
              css:{$: 'studio.profile-as-text',  path: '%$styleSource/path%~css' }
            }
          }
        }
      ]
    }
  }
})

jb.component('studio.style-editor', {
  type: 'control', 
  params: [{ id: 'path', as: 'string' }], 
  impl :{$: 'group', 
    controls: [
      {$: 'tabs', 
        tabs: [
          {$: 'group', 
            title: 'css', 
            style :{$: 'layout.vertical', 
              vSpacing: 20, 
              hSpacing: 20, 
              titleWidth: 100, 
              spacing: 3
            }, 
            controls: [
              {$: 'editable-text', 
                title: 'css', 
                databind :{$: 'studio.profile-as-string-byref', 
                  stringOnly: true, 
                  path: '%$path%~css'
                }, 
                style :{$: 'editable-text.codemirror', 
                  cm_settings: '', 
                  enableFullScreen: false, 
                  height: '300', 
                  mode: 'css', 
                  debounceTime: '2000', 
                  onCtrlEnter :{$: 'studio.refresh-preview' }
                }
              }, 
              {$: 'label', 
                title: 'jsx', 
                style :{$: 'label.heading', level: 'h5' }
              }, 
              {$: 'editable-text', 
                title: 'template', 
                databind :{
                  $pipeline: [
                    {$: 'studio.template-as-jsx', path: '%$path%~template' }, 
                    {$: 'studio.pretty', text: '%%' }
                  ]
                }, 
                style :{$: 'editable-text.codemirror', 
                  cm_settings: '', 
                  height: '200', 
                  mode: 'jsx', 
                  onCtrlEnter :{$: 'studio.refresh-preview' }
                }
              }
            ]
          }, 
          {$: 'group', 
            title: 'js', 
            controls: [
              {$: 'editable-text', 
                title: 'template', 
                databind :{$: 'studio.profile-as-text', 
                  stringOnly: true, 
                  path: '%$path%~template'
                }, 
                style :{$: 'editable-text.codemirror', 
                  cm_settings: '', 
                  height: '400', 
                  mode: 'javascript', 
                  onCtrlEnter :{$: 'studio.refresh-preview' }
                }
              }, 
              {$: 'button', 
                title: 'load from jsx/html', 
                action :{$: 'open-dialog', 
                  style :{$: 'dialog.dialog-ok-cancel', 
                    okLabel: 'OK', 
                    cancelLabel: 'Cancel'
                  }, 
                  content :{$: 'group', 
                    controls: [
                      {$: 'editable-text', 
                        title: 'jsx', 
                        databind: '%$jsx%', 
                        style :{$: 'editable-text.codemirror', 
                          enableFullScreen: true, 
                          debounceTime: 300
                        }
                      }
                    ]
                  }, 
                  title: 'Paste html / jsx', 
                  onOK :{$: 'write-value', 
                    to :{$: 'studio.ref', path: '%$path%~template' }, 
                    value :{$: 'studio.jsx-to-h', text: '%$jsx%' }
                  }, 
                  features: [
                    {$: 'var', 
                      name: 'jsx', 
                      value: 'paste your jsx here', 
                      mutable: 'true'
                    }
                  ]
                }, 
                style :{$: 'button.mdl-raised' }
              }
            ]
          }, 
          {$: 'group', 
            title: 'Inteliscript editor', 
            style :{$: 'layout.vertical' }, 
            controls: [{$: 'studio.jb-editor', path: '%$path%' }]
          }
        ], 
        style :{$: 'tabs.simple' }
      }
    ]
  }
})

jb.component('studio.style-editor-options', {
	type: 'menu.option',
	params: [
		{ id: 'path', as: 'string'},
	],
    impl :{$: 'menu.end-with-separator',
		$vars: {
		  compName :{$: 'studio.comp-name', path: '%$path%' }
		},
	  options: [
			{$: 'menu.action',
			  title: 'Style editor',
			  action :{
				$runActions: [
				  {$: 'studio.make-local', path: '%$path%' },
				  {$: 'studio.open-style-editor', path: '%$path%' }
				]
			  },
			  showCondition :{$: 'ends-with', endsWith: '~style', text: '%$path%' }
			},
			{$: 'menu.action',
			  title: 'Style editor of %$compName%',
			  action :{$: 'studio.open-style-editor', path: '%$compName%~impl' },
			  showCondition :{
				$and: [
				  {$: 'ends-with', endsWith: '~style', text: '%$path%' },
				  {$: 'notEmpty', item: '%$compName%' }
				]
			  }
			},
		]
    }
})


jb.component('studio.style-source', {
  params: [
    { id: 'path', as: 'string' }
  ],
  impl: (ctx,path) => {
      var st = jb.studio;
      var style = st.valOfPath(path);
      var compName = jb.compName(style);
      if (compName == 'custom-style')
        return { type: 'inner', path: path, style : style }
      var comp = compName && st.getComp(compName);
      if (comp && jb.compName(comp.impl) == 'custom-style')
          return { type: 'global', path: compName, style: comp.impl, innerPath: path }
  }
})

jb.component('studio.format-css', {
  params: [
    { id: 'css', as: 'string' }
  ],
  impl: (ctx,css) => {
    return css
      .replace(/{\s*/g,'{ ')
      .replace(/;\s*/g,';\n')
      .replace(/}[^$]/mg,'}\n\n')
      .replace(/^\s*/mg,'')
  }
})
;


jb.component('suggestions-test', {
  type: 'test',
  params: [
    { id: 'expression', as: 'string' },
    { id: 'selectionStart', as: 'number', defaultValue: -1 },
    { id: 'path', as: 'string', defaultValue: 'suggestions-test.default-probe~impl~title' },
    { id: 'expectedResult', type: 'boolean', dynamic: true, as: 'boolean' },
  ],
  impl :{$: 'data-test',
    calculate: ctx => {
      var params = ctx.componentContext.params;
      var selectionStart = params.selectionStart == -1 ? params.expression.length : params.selectionStart;

      var circuit = params.path.split('~')[0];
      var probeRes = new jb.studio.Probe(new jb.jbCtx(ctx,{ profile: { $: circuit }, comp: circuit, path: '', data: null }))
        .runCircuit(params.path);
      return probeRes.then(res=>{
        var probeCtx = res.result[0] && res.result[0].in;
        var obj = new jb.studio.suggestions({ value: params.expression, selectionStart: selectionStart })
          .extendWithOptions(probeCtx,probeCtx.path);
        return JSON.stringify(JSON.stringify(obj.options.map(x=>x.text)));
      })
    },
    expectedResult :{$call: 'expectedResult' }
  },
})

jb.component('jb-editor-children-test', {
  type: 'test',
  params: [
    { id: 'path', as: 'string' },
    { id: 'childrenType', as: 'string', type: ',jb-editor' },
    { id: 'expectedResult', type: 'boolean', dynamic: true, as: 'boolean' }
  ],
  impl :{$: 'data-test',
    calculate: ctx => {
      var params = ctx.componentContext.params;
      var mdl = new jb.studio.jbEditorTree('');
      var titles = mdl.children(params.path)
        .map(path=>
          mdl.title(path,true));
      return JSON.stringify(titles);
    },
    expectedResult :{$call: 'expectedResult' }
  },
})

jb.component('studio-probe-test', {
  type: 'test',
  params: [
    { id: 'circuit', type: 'control', dynamic: true },
    { id: 'probePath', as: 'string' },
    { id: 'allowClosestPath', as: 'boolean' },
    { id: 'expectedVisits', as: 'number', defaultValue : -1 },
  ],
  impl: (ctx,circuit,probePath,allowClosestPath,expectedVisits)=> {

    var testId = ctx.vars.testID;
    var failure = reason => ({ id: testId, title: testId, success:false, reason: reason });
    var success = _ => ({ id: testId, title: testId, success: true });

    var full_path = testId + '~impl~circuit~' + probePath;
    var probeRes = new jb.studio.Probe(new jb.jbCtx(ctx,{ profile: circuit.profile, forcePath: testId+ '~impl~circuit', path: '' } ))
      .runCircuit(full_path);
    return probeRes.then(res=>{
          try {
						if (expectedVisits == 0 && res.closestPath)
							return success();
            if (!allowClosestPath && res.closestPath)
              return failure('no probe results at path ' + probePath);
            if (res.result.visits != expectedVisits && expectedVisits != -1)
              return failure(`expected visits error actual/expected: ${res.result.visits}/${expectedVisits}`);
            if (!res.result[0])
                return failure('no probe results at path ' + probePath);
          } catch(e) {
            jb.logException(e,'jb-path-test');
            return failure('exception');
          }
          return success();
    })
  }
})

jb.component('path-change-test', {
  type: 'test',
  params: [
    { id: 'path', as: 'string' },
    { id: 'action', type: 'action', dynamic: true },
    { id: 'expectedPathAfter', as: 'string' },
    { id: 'cleanUp', type: 'action', dynamic: true  },
  ],
  impl: (ctx,path,action,expectedPathAfter,cleanUp)=> {
    var testId = ctx.vars.testID;
    var failure = (part,reason) => ({ id: testId, title: testId + '- ' + part, success:false, reason: reason });
    var success = _ => ({ id: testId, title: testId, success: true });

    var pathRef = jb.studio.refOfPath(path);
    action();
    pathRef.handler.refresh(pathRef);
    if (pathRef.$jb_path.join('~') != expectedPathAfter)
      var res = { id: testId, title: testId, success: false , reason: pathRef.$jb_path.join('~') + ' instead of ' + expectedPathAfter }
    else
      var res = { id: testId, title: testId, success: true };
    cleanUp();

    return res;
  }
})
;

(function() {
var st = jb.studio;

var probeCounter = 0;
st.Probe = class {
  constructor(ctx, noGaps) {
    if (ctx.probe)
      debugger;
    this.noGaps = noGaps;

    this.context = ctx.ctx({});
    this.probe = {};
    this.context.probe = this;
    this.context.profile = st.valOfPath(this.context.path); // recalc last version of profile
    this.circuit = this.context.profile;
    this.id = ++probeCounter;
  }

  runCircuit(pathToTrace,maxTime) {
		var st = jb.studio;
    this.maxTime = maxTime || 50;
    this.startTime = new Date().getTime();
    jb.logPerformance('probe','start',this);
    this.result = [];
    this.result.visits = 0;
    this.probe[pathToTrace] = this.result;
    this.pathToTrace = pathToTrace;
		var initial_resources = st.previewjb.valueByRefHandler.resources();
		var initial_comps = st.compsRefHandler.resources();
    if (st.probeDisabled) {
      this.completed = false;
      this.remark = 'probe disabled';
      return Promise.resolve(this);
    }

    return this.simpleRun()
//		  .catch(e => jb.logException(e,'probe run'))
	    .then( res =>
	      this.handleGaps())
		  .catch(e => jb.logException(e,'probe run'))
		  .then(res=>{
					this.completed = true;
		      this.totalTime = new Date().getTime()-this.startTime;
		      jb.logPerformance('probe','finished',this);
					// make values out of ref
					this.result.forEach(obj=> { obj.out = jb.val(obj.out) ; obj.in.data = jb.val(obj.in.data)});
					st.previewjb.valueByRefHandler.resources(initial_resources);
					st.compsRefHandler.resources(initial_comps);
		      return this;
				})
	}

	simpleRun() {
      var st = jb.studio;
			return Promise.resolve(this.context.runItself()).then(res=>{
				if (st.isCompNameOfType(jb.compName(this.circuit),'control')) {
					var ctrl = jb.ui.h(res.reactComp());
          st.probeEl = st.probeEl || document.createElement('div');
          st.probeResEl = jb.ui.render(ctrl, st.probeEl, st.probeResEl);
          return ({element: st.probeResEl});
				}
				return res;
			})
	}

  handleGaps(formerGap) {
    if (this.result.length > 0 || this.noGaps)
      return;
    var st = jb.studio;

		// find closest path
    var _path = st.parentPath(this.pathToTrace),breakingProp='';
    while (!this.probe[_path] && _path.indexOf('~') != -1) {
			breakingProp = _path.split('~').pop();
    	_path = st.parentPath(_path);
		}
		if (!this.probe[_path] || formerGap == _path) { // can not break through the gap
			this.closestPath = _path;
			this.result = this.probe[_path] || [];
			return;
		}

		// check if parent ctx returns object with method name of breakprop as in dialog.onOK
		var parentCtx = this.probe[_path][0].ctx, breakingPath = _path+'~'+breakingProp;
		var obj = this.probe[_path][0].out;
		if (obj[breakingProp] && typeof obj[breakingProp] == 'function')
			return Promise.resolve(obj[breakingProp]())
				.then(_=>this.handleGaps(_path));

	  // use the ctx to run the breaking param if it has no side effects
		var hasSideEffect = st.previewjb.comps[st.compNameOfPath(breakingPath)] && (st.previewjb.comps[st.compNameOfPath(breakingPath)].type ||'').indexOf('has-side-effects') != -1;
		if (!hasSideEffect)
			return Promise.resolve(parentCtx.runInner(parentCtx.profile[breakingProp],st.paramDef(breakingPath),breakingProp))
				.then(_=>this.handleGaps(_path));

		// could not solve the gap
		this.closestPath = _path;
		this.result = this.probe[_path] || [];
  }

	// called from jb_run
  record(context,parentParam) {
      if (this.id < probeCounter) {
        this.stopped = true;
        return
      }
      var now = new Date().getTime();
      if (!this.outOfTime && now - this.startTime > this.maxTime && !context.vars.testID) {
        jb.logPerformance('probe','out of time',this,now);
				this.outOfTime = true;
        //throw 'out of time';
      }
      var path = context.path;
      var input = context.ctx({probe: null});
      var out = input.runItself(parentParam,{noprobe: true});

      if (!this.probe[path]) {
        this.probe[path] = [];
        this.probe[path].visits = 0;
      }
      this.probe[path].visits++;
      var found;
      this.probe[path].forEach(x=>{
        found = jb.compareArrays(x.in.data,input.data) ? x : found;
      })
      if (found)
        found.counter++;
      else {
        var rec = {in: input, out: out, counter: 0, ctx: context};
        this.probe[path].push(rec);
      }
      return out;
  }
}

var probeEmitter = new jb.rx.Subject();

jb.component('studio.probe', {
	type:'data',
	params: [ { id: 'path', as: 'string', dynamic: true } ],
	impl: (ctx,path) => {
    var _jb = st.previewjb;
		var circuitCtx = ctx.vars.pickSelection && ctx.vars.pickSelection.ctx;
		if (!circuitCtx) {
			var circuitInPreview = st.closestCtxInPreview(path());
			if (circuitInPreview.ctx) {
			   st.highlight([circuitInPreview.elem]);
			   circuitCtx = circuitInPreview.ctx;
			}
		}
		if (!circuitCtx) {
			var circuit = ctx.exp('%$circuit%') || ctx.exp('%$studio/project%.%$studio/page%');
			circuitCtx = new _jb.jbCtx(new _jb.jbCtx(),{ profile: {$: circuit}, comp: circuit, path: '', data: null} );
		}
    var req = {path: path(), circuitCtx: circuitCtx };
    jb.delay(1).then(_=>probeEmitter.next(req));
    var probeQueue = probeEmitter.buffer(probeEmitter.debounceTime(500))
        .map(x=>x && x[0]).filter(x=>x)
        .flatMap(req=>
          new (_jb.studio.Probe || st.Probe)(req.circuitCtx).runCircuit(req.path)
        );

    return probeQueue.filter(x=>x.id == probeCounter).take(1).toPromise();
//      .race(jb.rx.Observable.fromPromise(jb.delay(1000).then(_=>({ result: [] }))))
  }
})



})()
;

(function() { var st = jb.studio;

st.initEventTracker = _ => {
	// debug the preview
	st.stateChangeEvents = [];
	st.previewjb.ui.stateChangeEm.subscribe(e=>{
		var curTime = e.timeStamp = new Date().getTime();
		st.stateChangeEvents.unshift(e);
		st.stateChangeEvents = st.stateChangeEvents.filter(ev=>ev.timeStamp > curTime - 2000)
	})
	// debug the studio
	st.studioStateChangeEvents = [];
	jb.ui.stateChangeEm.subscribe(e=>{
		var curTime = e.timeStamp = new Date().getTime();
		st.studioStateChangeEvents.unshift(e);
		st.studioStateChangeEvents = st.studioStateChangeEvents.filter(ev=>ev.timeStamp > curTime - 2000)
	})
}

//ui.stateChangeEm.next({cmp: cmp, opEvent: opEvent});
//({op: op, ref: ref, srcCtx: srcCtx, oldRef: oldRef, oldResources: oldResources});

jb.component('studio.event-title', {
	type: 'data',
	params: [ {id: 'event', as: 'single', defaultValue: '%%' } ],
	impl: (context,event) =>
		event ? st.pathSummary(event.cmp.ctxForPick.path).replace(/~/g,'/') : ''
});

jb.component('studio.event-cmp', {
	type: 'data',
	params: [ {id: 'event', as: 'single', defaultValue: '%%' } ],
	impl: (context,event) =>
		event ? st.pathSummary(event.cmp.ctxForPick.path).replace(/~/g,'/') : ''
});

jb.component('studio.event-cause', {
	type: 'data',
	params: [ {id: 'event', as: 'single', defaultValue: '%%' } ],
	impl: (context,event) =>
		(event && event.opEvent) ? st.nameOfRef(event.opEvent.ref) + ' changed to "' + st.valSummary(event.opEvent.newVal) + '"' : ''
});

jb.component('studio.state-change-events', {
	type: 'data',
	params: [ {id: 'studio', as: 'boolean' } ],
	impl: (ctx,studio) => 
		(studio ? st.studioStateChangeEvents : st.stateChangeEvents) || []
})

jb.component('studio.highlight-event', {
	type: 'action',
	params: [
		{id: 'event', as: 'single', defaultValue: '%%' }
	],
	impl :{$: 'studio.highlight-in-preview', path: '%$event/cmp/ctx/path%' }
})


jb.component('studio.open-event-tracker', {
  type: 'action', 
  params: [ {id: 'studio', as: 'boolean' } ],
  impl :{$: 'open-dialog', 
      content :{$: 'studio.event-tracker', studio: '%$studio%' }, 
      style :{$: 'dialog.studio-floating', 
        id: 'event-tracker', 
        width: '700', 
        height: '400'
      }, 
      title: {$if: '%$studio%', then: 'Studio Event Tracking', else: 'Event Tracking'}
  }
}) 

jb.component('studio.event-tracker', {
  type: 'control', 
  params: [ {id: 'studio', as: 'boolean' } ],
  impl :{$: 'group', 
    controls: [
      {$: 'table', 
        items :{$: 'studio.state-change-events', studio: '%$studio%' }, 
        fields: [
          {$: 'field.control', 
            title: 'changed', 
            control :{$: 'button', 
              title :{$: 'studio.name-of-ref', ref: '%opEvent/ref%' }, 
              action :{$: 'studio.goto-path', 
                path :{$: 'studio.path-of-ref', ref: '%opEvent/ref%' }
              }, 
              style :{$: 'button.href' }, 
              features :{$: 'feature.hover-title', 
                title :{$: 'studio.path-of-ref', ref: '%opEvent/ref%' }
              }
            }, 
            width: '100'
          }, 
          {$: 'field', 
            title: 'from', 
            data :{$: 'pretty-print', profile: '%opEvent/oldVal%' }, 
            width: '200'
          }, 
          {$: 'field', 
            title: 'to', 
            data :{$: 'pretty-print', profile: '%opEvent/newVal%' }, 
            width: '200'
          }, 
          {$: 'field.control', 
            title: 'action', 
            control :{$: 'button', 
              title: '%opEvent/srcCtx/path%', 
              action :{$: 'studio.goto-path', path: '%opEvent/srcCtx/path%' }, 
              style :{$: 'button.href' }
            }, 
            width: '100'
          }, 
          {$: 'field.control', 
            title: 'refreshing', 
            control :{$: 'button', 
              title :{$: 'studio.event-cmp' }, 
              action :{$: 'studio.goto-path', 
                target: 'new tab', 
                path: '%cmp/ctxForPick/path%'
              }, 
              style :{$: 'button.href' }, 
              features: [
                {$: 'feature.onHover', 
                  action :{$: 'studio.highlight-event' }
                }
              ]
            }, 
            width: '200'
          }, 
          {$: 'field.control', 
            title: 'watched at', 
            control :{$: 'button', 
              title: '%watchedAt/path%', 
              action :{$: 'studio.goto-path', path: '%watchedAt/path%' }, 
              style :{$: 'button.href' }
            }, 
            width: '100'
          }
        ], 
        style :{$: 'table.with-headers' }
      }
    ], 
    features :{$if: '%$studio%',
	    then: {$: 'watch-observable', 
	      toWatch: ctx => jb.ui.stateChangeEm.debounceTime(500), 
	    },
	    else: {$: 'watch-observable', 
	      toWatch: ctx => st.previewjb.ui.stateChangeEm.debounceTime(500), 
	    }
	}
  }
})

})();

function h_to_jsx({types: t}) {
  const getAttributes = (props) => {
    if (t.isIdentifier(props) || t.isMemberExpression(props)) {
      return [t.JSXSpreadAttribute(props)];
    }

    return (props && props.properties || []).map(prop => {
      const key = t.JSXIdentifier(prop.key.name || prop.key.value)
      const value = t.isLiteral(prop.value) && (typeof prop.value.value === 'string') ? prop.value : t.JSXExpressionContainer(prop.value);
      return t.JSXAttribute(key, value);
    });
  }

  const processChildren = (children) => {
    return children.map(c => {
      if (t.isJSXElement(c) || t.isJSXExpressionContainer(c)) {
        return c;
      } else if (t.isStringLiteral(c)) {
        return t.JSXText(c.value);
      } else {
        return t.JSXExpressionContainer(c);
      }
    });
  }

  return {
    visitor: {
      CallExpression: {
        exit: function (path, state) {
          if (path.node.callee.name != 'h' || path.node.arguments[0].type != 'StringLiteral') return;

          var name = t.JSXIdentifier(path.node.arguments[0].value);
          var props = getAttributes(path.node.arguments[1]);
          var children = processChildren(path.node.arguments.slice(2));

          var open = t.JSXOpeningElement(name, props);
          open.selfClosing = children.length === 0;
          var close = children.length === 0 ? null : t.JSXClosingElement(name);

          var el = t.JSXElement(open, close, children);
          path.replaceWith(path.parent.type === 'ReturnStatement' ? t.ParenthesizedExpression(el) : t.ExpressionStatement(el));
        }
      }
    }
  }
}

jb.studio.initJsxToH = _ => {
  if (jb.studio._initJsxToH) return;
  Babel.registerPlugin('h-to-jsx',h_to_jsx);
  jb.studio._initJsxToH = true;
}

jb.studio.testJsxToH = _ => {
    input = (state,h) => h('div',{a: state.a},h('span'));
    var res = jb.studio.hToJSX(input.toString().split('=>').slice(1).join('=>'));
    console.log('jsx',jb.studio.pretty(res));
    console.log('back to h',jb.studio.jsxToH(res))
}

//jb.delay(500).then(_ => jb.studio.testJsxToH())


jb.studio.jsxToH = jsx => {
  jb.studio.initJsxToH();
  try  {
  return Babel.transform(jsx, {
    "plugins": [["transform-react-jsx", { "pragma": "h"  }]]
  }).code.replace(/;$/,'').replace(/\(\s*/mg,'(').replace(/\s*\)/mg,')').replace(/,null,/mg,',{},').replace(/,\s*\{/mg,',{').replace(/"class"/mg,'class').replace(/"/mg,"'")
  } catch(e) {
    jb.logException(e)
  }
}

jb.studio.hToJSX = hFunc => {
    jb.studio.initJsxToH();
    try {
    return Babel.transform(hFunc, {
      "plugins": ['h-to-jsx']
  }).code
  } catch(e) {
    jb.logException(e)
  }
}

jb.component('studio.pretty', {
	type: 'data',
	params: [{ id: 'text', as: 'string', defaultValue: '%%' } ],
	impl: (ctx,text) => jb.studio.pretty(text)
})

jb.component('studio.jsx-to-h', {
	type: 'data',
	params: [{ id: 'text', as: 'string', defaultValue: '%%' } ],
	impl: (ctx,text) => jb.studio.jsxToH(text)
})

jb.component('studio.h-to-jsx', {
	type: 'data',
	params: [{ id: 'text', as: 'string', defaultValue: '%%' } ],
	impl: (ctx,text) => jb.studio.hToJSX(text)
})


jb.component('studio.template-as-jsx', {
	type: 'data',
	params: [{ id: 'path', as: 'string', dynamic: true } ],
	impl: ctx => ({
		$jb_val: function(value) {
			var st = jb.studio;
			var path = ctx.params.path();
			if (!path) return;
			if (typeof value == 'undefined') {
				var func = st.valOfPath(path);
				if (typeof func == 'function')
            		return jb.studio.hToJSX(func.toString().split('=>').slice(1).join('=>') );
			} else {
				var funcStr = jb.studio.jsxToH(value);
				if (funcStr)
            		st.writeValueOfPath(path,st.evalProfile('(cmp,state,h) => ' + funcStr) );
			}
		},
		$jb_observable: cmp =>
			jb.studio.refObservable(jb.studio.refOfPath(ctx.params.path()),cmp,{includeChildren: true})
	})
})
;

