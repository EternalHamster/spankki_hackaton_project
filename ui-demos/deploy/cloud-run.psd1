@{
    Service = 'oma-talous-ui'
    Region = 'europe-north1'
    RuntimeAccount = 'oma-talous-ui'
    BuildAccount = 'oma-talous-ui-build'
    Cpu = 1
    Memory = '1Gi'
    MinInstances = 0
    MaxInstances = 1
    Concurrency = 80
    TimeoutSeconds = 120
    ChatSecret = 'money-coach-anthropic-key'
    ChatSecretVersion = '1'
    SessionSecret = 'oma-talous-demo-session'
    SessionSecretVersion = '1'
}
