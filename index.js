/*
 * fis
 * http://fis.baidu.com/
 */

'use strict';

var combineCount = 0;
var combineCache = {};
var stable = require("stable");
var defaultSetting = {
    autoCombine : false,
    autoReflow : false,
    fullPackHit : {
        js : false,
        css : false
    },
    headTag: "</head>",
    bodyTag: "</body>",
    output: 'pkg/auto_combine_${hash}'
};

var placeHolders = {};

function trimQuery(url){
    if (url.indexOf("?") !== -1) {
        url = url.slice(0, url.indexOf("?"));
    }
    return url;
}


function wrapTag(reg){
    if(typeof reg === 'string'){
        return new RegExp(fis.util.escapeReg(reg));
    } else if(!fis.util.is(reg, 'RegExp')){
        fis.log.error('invalid regexp [' + reg + ']');
    }
    return reg;
}

/**
 * 获取html页面中的<script ... src="path"></script> 资源
 * 获取html页面中的<link ... rel="stylesheet" href="path" /> 资源
 * 由于已经在标准流程之后，无需处理inline
 * 不需要改动页面中内嵌的样式
 * 需要将页面中内嵌的脚本移动到所有脚本的最下方
 * 需要去除注释内的引用
 * @param content
 * @param pathMap
 * @param usePlaceholder
 */
function analyzeHtml(content, pathMap, usePlaceholder) {
    var reg = /(<script(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?:<\/script\s*>)\s*|<(link)\s+[\s\S]*?["'\s\w\/]>\s*|<!--([\s\S]*?)-->\s*/ig;
    var single, result;
    var resources = {
        scripts: [],
        inlineScripts: [],
        styles: []
    };
    var replaced = content.replace(reg, function (m, $1, $2, $3, $4) {
        var resourceID = null;
        var result = null;
        //$1为script标签, $2为内嵌脚本内容, $3为link标签, $4为注释内容
        if ($1) {
            //如果标签设置了data-fixed则不会收集此资源
            if (/(\sdata-fixed\s*=\s*)('true'|"true")/ig.test($1)) {
                return m;
            }
            var head = /(\sdata-position\s*=\s*)('head'|"head")/ig.test($1);
            result = m.match(/(?:\ssrc\s*=\s*)(?:'([^']+)'|"([^"]+)"|[^\s\/>]+)/i);
            if (!result || !(result[1] || result[2])) {
                if (usePlaceholder){
                    return m;
                }
                resources.inlineScripts.push({content: m, head: head });
                return "";
            } else {
                var jsUrl = trimQuery(result[1] || result[2]);
                //不在资源表中的资源不处理
                if (!pathMap[jsUrl]){
                    return m;
                }
                single = /(\sdata-single\s*=\s*)('true'|"true")/ig.test($1);
                resourceID = pathMap[jsUrl];
                resources.scripts.push({
                    content: m,
                    id: resourceID,
                    single: single,
                    head: head
                });
            }
        } else if ($3) {
            var isCssLink = false;
            result = m.match(/\srel\s*=\s*('[^']+'|"[^"]+"|[^\s\/>]+)/i);
            if (result && result[1]) {
                var rel = result[1].replace(/^['"]|['"]$/g, '').toLowerCase();
                isCssLink = rel === 'stylesheet';
            }
            //对rel不是stylesheet的link不处理
            if (!isCssLink){
                return m;
            }
            //如果标签设置了data-fixed则不会收集此资源
            if (/(\sdata-fixed\s*=\s*)('true'|"true")/ig.test(m)) {
                return m;
            }
            result = m.match(/(?:\shref\s*=\s*)(?:'([^']+)'|"([^"]+)"|[^\s\/>]+)/i);
            if (result && (result[1] || result[2])) {
                var cssUrl = trimQuery(result[1] || result[2]);
                if (!pathMap[cssUrl]){
                    return m;
                }
                single = /(\sdata-single\s*=\s*)('true'|"true")/ig.test(m);
                resourceID = pathMap[cssUrl];
                resources.styles.push({
                    content: m,
                    id: resourceID,
                    single: single
                });
            }
        } else if ($4) {
            //不处理注释
            return m;
        }
        var placeHolderID = '<!--RESOURCE_' + resourceID + '_PLACEHOLDER-->';
        placeHolders[resourceID] = placeHolderID;
        return usePlaceholder ? placeHolderID : "";
    });
    return {
        resources: resources,
        content: replaced
    };
}

function getResourcePathMap(ret, conf, settings, opt) {
    var map = {};
    fis.util.map(ret.map.res, function (subpath, file) {
        map[trimQuery(file.uri)] = subpath;
    });
    fis.util.map(ret.pkg, function (subpath, file) {
        map[trimQuery(file.getUrl(opt.hash, opt.domain))] = file.getId();
    });
    return map;
}

function getPackMap(ret, conf, settings, opt){
    var uriToIdMap = {};
    var fileToPack = {};
    var packToFile = {};
    fis.util.map(ret.map.pkg, function(id, pkg){
        uriToIdMap[pkg.uri] = id;
    });
    fis.util.map(ret.pkg, function (subpath, file) {
        var uri = file.getUrl(opt.hash, opt.domain);
        var id = uriToIdMap[uri];
        if (id){
            //没有ID的PKG文件无需建立MAP
            packToFile[id] = file;
            fileToPack[file.getId()] = {
                id: id,
                pkg : ret.map.pkg[id]
            };
        }
    });
    return {
        packToFile: packToFile,
        fileToPack: fileToPack
    };
}

/**
 * 将页面依赖的资源与打包资源对比合并
 * @param resources
 * @param ret
 * @param fullPackHit 是否要求资源整体命中打包对象
 * @returns {Array}
 */
function getPkgResource(resources, ret, fullPackHit) {
    var pkgList = {};
    var list = [];
    var handled = {};
    var idList = resources.map(function(resource){
       return  resource.id;
    });
    var resourceMap = {};
    resources.forEach(function(resource){
        resourceMap[resource.id] = resource;
    });

    function fullPackPass(resource){
        if (!fullPackHit){
            return true;
        }
        var pkg = ret.map.pkg[ret.map.res[resource.id].pkg];
        var unHit = pkg.has.filter(function (id) {
            return idList.indexOf(id) == -1;
        });
        return unHit.length === 0;
    }

    function addPkg(id, pkg, srcId){
        if (pkgList[id])
            return;
        var head = false;
        pkg.has.forEach(function(inPkg){
            handled[inPkg] = true;
            if (resourceMap[inPkg]){
                head = head || (resourceMap[inPkg].head || false);
            }
        });
        pkgList[id] = true;
        list.push({
            type: 'pkg',
            id: id,
            srcId: srcId,
            head: head
        });
    }

    resources.forEach(function (resource) {
        var id = resource.id;
        if (handled[id]){
            return false;
        }
        //当前资源是pack打包后的结果
        if (ret.packMap.fileToPack[id]){
            var pack = ret.packMap.fileToPack[id];
            addPkg(pack.id, pack.pkg, id);
            return true;
        }
        var res = ret.map.res[id];
        handled[id] = true;
        if (res.pkg && fullPackPass(resource)) {
            addPkg(res.pkg, ret.map.pkg[res.pkg], id);
        } else {
            list.push({
                type: 'res',
                id: id,
                single: resource.single,
                head: resource.head
            });
        }
    });
    return list;
}

/**
 * 自动打包零散资源
 * @param resList
 * @param ret
 * @param settings
 * @param conf
 * @param opt
 * @returns {Array}
 */
function autoCombine(resList, ret, conf, settings, opt) {
    var list = [];
    var toCombine = [];
    var fileExt;

    function getCombineHash(list){
        var idList = list.map(function(res){
            return res.id;
        });
        return stable(idList).join(',');
    }

    function flushCombine() {
        if (toCombine.length == 1) {
            //单独的文件不进行处理
            list.push(toCombine[0]);
            toCombine = [];
            return;
        }
        if (toCombine.length !== 0) {
            var hash = getCombineHash(toCombine);
            var content = '';
            var index = 0;
            var has = [];
            var id;
            if (combineCache[hash]){
                fis.log.debug('auto combine hit cache [' + hash + ']');
                id = combineCache[hash];
            }
            else{
                toCombine.forEach(function (res) {
                    var file = ret.ids[res.id];
                    var c = file.getContent();
                    has.push(file.getId());
                    if (!fileExt) {
                        fileExt = file.isJsLike ? 'js' : 'css';
                    }
                    if (c !== '') {
                        if (index++ > 0) {
                            content += '\n';
                            if (file.isJsLike) {
                                content += ';';
                            } else if (file.isCssLike) {
                                c = c.replace(/@charset\s+(?:'[^']*'|"[^"]*"|\S*);?/gi, '');
                            }
                        }
                        content += c;
                    }
                });

                var subpath = settings.output.replace('${index}', combineCount)
                                    .replace('${hash}', fis.util.md5(stable(has).join(','), 5))
                                 + '.' + fileExt;
                var file = fis.file(fis.project.getProjectPath(), subpath);
                ret.pkg[file.subpath] = file;
                file.setContent(content);
                id = "auto_" + fileExt + "_" + combineCount;
                ret.map.pkg[id] = {
                    uri: file.getUrl(opt.hash, opt.domain),
                    type: fileExt,
                    has: has
                };
                combineCache[hash] = id;
                combineCount++;
            }
            list.push({
                type: 'pkg',
                id: id
            });
            toCombine = [];
        }
    }

    resList.forEach(function (res) {
        if (res.type === 'pkg') {
            flushCombine();
            list.push(res);
        } else {
            if (res.single) {
                flushCombine();
                list.push(res);
            } else {
                toCombine.push(res);
            }
        }
    });
    flushCombine();
    return list;
}


function getCharset(file) {
    var charset = file? file.charset : fis.config.get('project.charset');
    switch (charset) {
        case 'utf8':
            return 'utf-8';
        default:
            return charset;
    }
}

function injectJs(jsList, content, ret, settings) {
    var scripts = '', headScripts = '';
    jsList.forEach(function (js) {
        var uri, file;
        if (js.type === 'pkg') {
            uri = ret.map.pkg[js.id].uri;
            file = ret.packMap.packToFile[js.id];
        } else {
            uri = ret.map.res[js.id].uri;
            file = ret.src[js.id];
        }
        var script = '<script type="text/javascript" charset="' + getCharset(file) + '" src="' + uri + '"></script>\n';
        if (js.head){
            headScripts += script;
        }else{
            scripts += script;
        }
    });
    content = modBodyContent(content, scripts, settings);
    content = modHeadContent(content, headScripts, settings);
    return content;
}

function injectCss(cssList, content, ret, settings) {
    var styles = '';
    cssList.forEach(function (css) {
        var uri;
        if (css.type === 'pkg') {
            uri = ret.map.pkg[css.id].uri;
        } else {
            uri = ret.map.res[css.id].uri;
        }
        styles += '<link type="text/css" rel="stylesheet" href="' + uri + '">\n';
    });
    content = modHeadContent(content, styles, settings);
    return content;
}

function injectInlineJs(inlineScripts, content, ret, settings) {
    var inlines = '', headInlines = '';
    inlineScripts.forEach(function (script) {
        if (script.head){
            headInlines += script.content;
        }else{
            inlines += script.content;
        }
    });
    content = modBodyContent(content, inlines, settings);
    content = modHeadContent(content, headInlines, settings);
    return content;
}

function modHeadContent(content, mod, settings){
    if (settings.headTag.test(content)){
        content = content.replace(settings.headTag, mod + '$&');
    }else if (settings.forceOutput){
        content = mod + content;
    }
    return content;
}

function modBodyContent(content, mod, settings){
    if (settings.bodyTag.test(content)){
        content = content.replace(settings.bodyTag, mod + '$&');
    }else if (settings.forceOutput){
        content += mod;
    }
    return content;
}

function injectJsWithPlaceHolder(jsList, content, ret){
    jsList.forEach(function (js) {
        var uri, id, file;
        if (js.type === 'pkg') {
            uri = ret.map.pkg[js.id].uri;
            file = ret.packMap.packToFile[js.id];
            id = js.srcId;
        } else {
            uri = ret.map.res[js.id].uri;
            file = ret.src[js.id];
            id = js.id;
        }
        var script = '<script type="text/javascript" charset="' + getCharset(file) + '" src="' + uri + '"></script>\n';
        content = content.replace(placeHolders[id], script);
        placeHolders[id] = false;
    });
    return content;
}

function injectCssWithPlaceHolder(cssList, content, ret){
    cssList.forEach(function (css) {
        var uri, id;
        if (css.type === 'pkg') {
            uri = ret.map.pkg[css.id].uri;
            id = css.srcId;
        } else {
            uri = ret.map.res[css.id].uri;
            id = css.id;
        }
        var style = '<link type="text/css" rel="stylesheet" href="' + uri + '">\n';
        content = content.replace(placeHolders[id], style);
        placeHolders[id] = false;
    });
    return content;
}

function cleanPlaceHolder(content){
    fis.util.map(placeHolders, function(id, placeholder){
        if (placeholder){
            content = content.replace(placeholder, '');
        }
        placeHolders[id] = false;
    });
    return content;
}


module.exports = function (ret, conf, settings, opt) { //打包后处理
    if (!opt.pack){
        return;
    }
    combineCache = {};
    combineCount = 0;
    settings = fis.util.merge(fis.util.clone(defaultSetting), settings);
    settings.headTag = wrapTag(settings.headTag);
    settings.bodyTag= wrapTag(settings.bodyTag);
    var pathMap = getResourcePathMap(ret, conf, settings, opt);
    ret.packMap = getPackMap(ret, conf, settings, opt);
    //autoCombine模式下，autoReflow必为真
    if(settings.autoCombine)
        settings.autoReflow = true;
    fis.util.map(ret.src, function (subpath, file) {
        if (file.isHtmlLike && file.noMapJs !== false) { //类html文件
            placeHolders = {};
            var content = file.getContent();
            var result = analyzeHtml(content, pathMap, !settings.autoReflow);
            content = result.content;
            var jsList = getPkgResource(result.resources.scripts, ret, settings.fullPackHit.js);
            var cssList = getPkgResource(result.resources.styles, ret, settings.fullPackHit.css);
            if (settings.autoCombine) {
                jsList = autoCombine(jsList, ret, conf, settings, opt);
                cssList = autoCombine(cssList, ret, conf, settings, opt);
            }
            if (settings.autoReflow){
                content = injectJs(jsList, content, ret, settings);
                content = injectCss(cssList, content, ret, settings);
                content = injectInlineJs(result.resources.inlineScripts, content, ret, settings);
            }else{
                content = injectJsWithPlaceHolder(jsList, content, ret);
                content = injectCssWithPlaceHolder(cssList, content, ret);
                content = cleanPlaceHolder(content);
            }
            file.setContent(content);
            if (file.useCache){
                ret.pkg[file.subpath] = file;
            }
        }
    });
};
