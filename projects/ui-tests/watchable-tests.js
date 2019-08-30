jb.component('ui-test.check-box-with-calculated-and-watch-ref',  /* uiTest_checkBoxWithCalculatedAndWatchRef */ {
    impl: uiTest({
        control: editableBoolean({
        databind: '%$person/name% == \"Homer Simpson\"',
        style: editableBoolean_checkboxWithTitle(),
        textForTrue: 'yes',
        textForFalse: 'nonono',
        features: watchRef('%$person/name%')
        }),
        action: runActions(writeValue('%$person/name%', 'Mukki'), delay(200)),
        expectedResult: contains('nonono'),
        expectedCounters: {setState: 1}
    })
})

jb.component('ui-test.boolean-watchable-var-as-boolean-true-to-false', {
    impl: uiTest({
      control: label({
        title: pipeline(test_getAsBool('%$var1%'),({data}) => data === false ? 'OK' : 'Error'),
        features: [
          variable({name: 'var1', value: true, watchable: true}),
          watchRef('%$var1%'),
          feature_afterLoad(writeValue('%$var1%', false))
        ]
      }),
      expectedResult: contains('OK')
    })
})

jb.component('ui-test.boolean-watchable-var-as-boolean-false-to-true', {
    impl: uiTest({
      control: label({
        title: pipeline(test_getAsBool('%$var1%'),({data}) => data === true ? 'OK' : 'Error'),
        features: [
          variable({name: 'var1', value: false, watchable: true}),
          watchRef('%$var1%'),
          feature_afterLoad(writeValue('%$var1%', true))
        ]
      }),
      expectedResult: contains('OK')
    })
})

jb.component('ui-test.watchable-var',  /* uiTest_mutableVar */ {
    impl: uiTest({
      control: label({
        title: '%$var1%',
        features: [
          variable({name: 'var1', value: 'hello', watchable: true}),
          feature_afterLoad(writeValue('%$var1%', 'foo'))
        ]
      }),
      action: ctx => jb.delay(1).then(_ => jb.delay(1)),
      expectedResult: contains('foo')
    })
})

jb.component('ui-test.watchable-var-with-global-id',  /* uiTest_mutableVarWithGlobalId */ {
    impl: uiTest({
      control: label({
        title: '%$var1%',
        features: [
          variable({name: 'var1', value: 'hello', watchable: true, globalId: 'globalVar1'}),
          feature_afterLoad(writeValue('%$var1%', 'foo'))
        ]
      }),
      action: ctx => jb.delay(1).then(_ => jb.delay(1)),
      expectedResult: contains('foo')
    })
})

jb.component('ui-test.watchable-var-as-object',  /* uiTest_mutableVarAsObject */ {
    impl: uiTest({
      control: label({
        title: '%$obj1/txt%',
        features: [
          variable({name: 'obj1', value: {$: 'object', txt: 'hello'}, watchable: true}),
          feature_afterLoad(writeValue('%$obj1/txt%', 'foo'))
        ]
      }),
      action: ctx => jb.delay(1).then(_ => jb.delay(1)),
      expectedResult: contains('foo')
    })
})

jb.component('ui-test.watchable-var-as-array',  /* uiTest_mutableVarAsArray */ {
    impl: uiTest({
      control: group({
        controls: label('%$items[1]/title%'),
        features: variable({
          name: 'items',
          value: asIs([{title: 'koo'}, {title: 'foo'}]),
          watchable: true,
          globalId: 'items'
        })
      }),
      expectedResult: contains('foo')
    })
})

jb.component('ui-test.watchable-var-as-array-one-item',  /* uiTest_mutableVarAsArrayOneItem */ {
    impl: uiTest({
      control: group({
        controls: label('%$items[0]/title%'),
        features: variable({name: 'items', value: asIs([{title: 'foo'}]), watchable: true, globalId: 'items'})
      }),
      expectedResult: contains('foo')
    })
})


  jb.component('ui-test.watchable-var-as-object-not-initialized',  /* uiTest_mutableVarAsObjectNotInitialized */ {
    impl: uiTest({
      control: label({
        title: '%$obj1/txt%',
        features: [
          variable({name: 'obj1', value: {$: 'object'}, watchable: true}),
          feature_afterLoad(writeValue('%$obj1/txt%', 'foo'))
        ]
      }),
      action: ctx => jb.delay(1).then(_ => jb.delay(1)),
      expectedResult: contains('foo')
    })
})

jb.component('ui-test.calculated-var',  /* uiTest_calculatedVar */ {
    impl: uiTest({
      control: group({
        controls: [
          editableText({databind: '%$var1%', features: id('var1')}),
          editableText({databind: '%$var2%'}),
          label('%$var3%')
        ],
        features: [
          variable({name: 'var1', value: 'hello', watchable: true}),
          variable({name: 'var2', value: 'world', watchable: true}),
          calculatedVar({name: 'var3', value: '%$var1% %$var2%', watchRefs: list('%$var1%', '%$var2%')})
        ]
      }),
      action: uiAction_setText('hi', '#var1'),
      expectedResult: contains('hi world')
    })
})

jb.component('ui-test.calculated-var-cyclic',  /* uiTest_calculatedVarCyclic */ {
    impl: uiTest({
      control: group({
        controls: [
          editableText({databind: '%$var1%', features: id('var1')}),
          editableText({databind: '%$var2%'}),
          label('%$var3%')
        ],
        features: [
          calculatedVar({name: 'var1', value: 'xx%$var3%', watchRefs: '%$var3%'}),
          variable({name: 'var2', value: 'world', watchable: true}),
          calculatedVar({name: 'var3', value: '%$var1% %$var2%', watchRefs: list('%$var1%', '%$var2%')})
        ]
      }),
      action: uiAction_setText('hi', '#var1'),
      expectedResult: contains('hi world')
    })
})

jb.component('ui-test.boolean-not-reffable-true',  /* uiTest_booleanNotReffableTrue */ {
    impl: uiTest({
      control: label({title: isOfType('string', '123')}),
      expectedResult: contains('true')
    })
})

jb.component('ui-test.boolean-not-reffable-false',  /* uiTest_booleanNotReffableFalse */ {
    impl: uiTest({
      control: label({title: isOfType('string2', '123')}),
      expectedResult: contains('false')
    })
})

jb.component('ui-test.label-with-watch-ref-in-spliced-array',  /* uiTest_labelWithWatchRef */ {
    impl: uiTest({
      control: label({
        title: '%$personWithChildren/children[1]/name%',
        features: watchRef('%$personWithChildren/children%')
      }),
      action: splice({array: '%$personWithChildren/children%', fromIndex: 0, noOfItemsToRemove: 1}),
      expectedResult: contains('Maggie'),
      expectedCounters: {setState: 1}
    })
})

jb.component('ui-test.label-not-watching-ui-var', {
  impl: uiTest({
    control: label({
      title: '%$text1/text%',
      features: [
        variable({name: 'text1', value: obj(prop('text','OK'))}),
        feature_afterLoad(writeValue('%$text1/text%', 'not good'))
      ]
    }),
    expectedCounters: {setState: 0},
    expectedResult: contains('OK')
  })
})

jb.component('ui-test.label-not-watching-basic-var', {
  impl: uiTest({
    control: label({
      vars: Var('text1', obj(prop('text','OK'))),
      title: '%$text1/text%',
      features: [
        feature_afterLoad(writeValue('%$text1/text%', 'not good'))
      ]
    }),
    expectedCounters: {setState: 0},
    expectedResult: contains('OK')
  })
})

jb.component('ui-test.group-watching-without-includeChildren', {
  impl: uiTest({
    control: group({
      controls: label('%$text1/text%'),
    features: [
      variable({name: 'text1', value: obj(prop('text','OK'))}),
      watchRef({ref: '%$text1%'}),
      feature_afterLoad(writeValue('%$text1/text%', 'not good'))
    ]
  }),
    expectedCounters: {setState: 0},
    expectedResult: contains('OK')
  })
})

jb.component('ui-test.group-watching-with-includeChildren', {
  impl: uiTest({
    control: group({
      controls: label('%$text1/text%'),
      features: [
        variable({name: 'text1', watchable: true, value: obj(prop('text','OK'))}),
        watchRef({ref: '%$text1%', includeChildren: 'yes'}),
        feature_afterLoad(writeValue('%$text1/text%', 'changed'))
      ]
    }),
    expectedCounters: {setState: 2}, // a kind of bug fixed with includeChildren: 'structure'
    expectedResult: contains('changed')
  })
})

jb.component('ui-test.group-watching-structure', {
  impl: uiTest({
    control: group({
      controls: label('%$text1/text%'),
      features: [
        variable({name: 'text1', watchable: true, value: obj(prop('text','OK'))}),
        watchRef({ref: '%$text1%', includeChildren: 'structure'}),
        feature_afterLoad(writeValue('%$text1/text%', 'changed'))
      ]
    }),
    expectedCounters: {setState: 1},
    expectedResult: contains('changed')
  })
})

jb.component('ui-test.watch-ref-array-delete-with-run-action-on-items',  {
  impl: uiTest({
    control: group({
      controls: label({
          title: json.stringify("%$watchable-people%"),
          features: watchRef({ref: '%$watchable-people%', includeChildren: 'yes'}) 
      }),
      features: [
        feature_afterLoad( 
          runActionOnItems('%$watchable-people%', 
            splice({
              array: "%$watchable-people%",
              fromIndex: indexOf("%$watchable-people%", '%%'),
              noOfItemsToRemove: '1',
              itemsToAdd: []
            })))
      ]
    }),
    expectedCounters: { setState: 3},
    expectedResult: contains('[]')
  })
})   