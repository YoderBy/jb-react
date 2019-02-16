jb.component('data-test.object-encoder.stringify', {
	 impl :{$: 'data-test',
		calculate: ctx =>  {
            const base = { base: true };
            const top = { text:'textVal', leaf1: base, leaf2: base};
            return jb.objectEncoder.stringify(top)
        },
		expectedResult : ctx => { 
            return ctx.data === `[{"text":1,"leaf1":2,"leaf2":2},"textVal",{"base":3},true]`
        }
	},
})

jb.component('data-test.object-encoder.encode-decode', {
    impl :{$: 'data-test',
       calculate: ctx =>  {
           const base = { base: true };
           const top = { text:'textVal', leaf1: base, leaf2: base};
           return {top, result: jb.objectEncoder.decode(jb.objectEncoder.encode(top))}
       },
       expectedResult : ctx => { 
           return JSON.stringify(ctx.data.top) === JSON.stringify(ctx.data.result)
       }
   },
})

jb.component('data-test.object-encoder.encode-jb time', {
    impl :{$: 'data-test',
       calculate: ctx =>  {
           const time = Date.now();
           const jb2 = jb.objectEncoder.decode(jb.objectEncoder.encode(jb));
            jb.objectEncoder.decode(jb.objectEncoder.encode(ctx));
            jb2.comps;
            return Date.now() - time
       },
       expectedResult : ctx => { 
           return ctx.data < 500 // less than 200 msec
       }
   },
})
